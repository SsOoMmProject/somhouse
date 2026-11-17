"""Regression checks using temporary SQLite, synthetic family data and HTTP fixtures."""
from datetime import datetime, timedelta
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from google_records import (GoogleAPI, GoogleAuthError, GoogleError, GoogleRecords, SEOUL, TAB,
                            encode, json_request, save_config, voice_payload)
from server import Store, FamilyServer
from shopping_records import choose_price, matches_price, purchase_payload


class GoogleRegression(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        self.config = {"binding": "test", "inbox": "@default", "task_list": "archive", "spreadsheet": "sheet",
                       "calendar_inbox": "primary", "calendar_outbox": "feeding", "refresh_token": "fake"}
        self.bridge = GoogleRecords(self.store, self.config)

    def feeding(self, item_id):
        return {"id": item_id, "type": "feeding", "date": "2026-01-01T10:00", "category": "분유", "amount": "120ml"}

    def queue(self, *ids):
        with self.store.connect() as db:
            for item_id in ids:
                item = self.feeding(item_id)
                db.execute("INSERT OR REPLACE INTO items VALUES ('records',?,?)", (item_id, encode(item)))
                self.bridge.queue(db, "records", item_id, item, "save")

    def retry_now(self):
        with self.store.connect() as db:
            db.execute("UPDATE google_delivery_retries SET next_retry_at=0")

    def rows(self, sql, params=()):
        with self.store.connect() as db:
            return db.execute(sql, params).fetchall()

    def test_poison_sheet_does_not_block_next_batch_and_survives_restart(self):
        self.queue(*[str(i) for i in range(14)])
        sent = []
        def write(row, values):
            if values[5] == '0':
                raise GoogleError(400, "Sheets")
            sent.append(values[5])
        with patch.object(self.bridge.api, 'sheet_row', side_effect=write):
            self.bridge.deliver('sheets')
            self.bridge.deliver('sheets')
        self.assertEqual(sent, [str(i) for i in range(1, 14)])
        self.assertEqual(self.rows('SELECT attempts,failed FROM google_delivery_retries'), [(1, 0)])
        reopened = GoogleRecords(Store(self.temp.name), self.config)
        with patch.object(reopened.api, 'sheet_row', side_effect=write), patch.object(reopened.api, 'sheet_cell', return_value=[]):
            reopened.deliver('sheets')
            self.assertEqual(self.rows('SELECT attempts FROM google_delivery_retries'), [(1,)])
            for _ in range(4):
                self.retry_now()
                reopened.deliver('sheets')
            self.retry_now()
            reopened.deliver('sheets')
        self.assertEqual(self.rows('SELECT attempts,failed FROM google_delivery_retries'), [(5, 1)])
        with self.store.connect() as db:
            self.assertEqual(reopened.status(db)['services']['sheets']['failed'], 1)

    def test_tasks_fail_independently_and_newer_edit_supersedes_failed_old_edit(self):
        self.queue('bad', 'good')
        sent = []
        def send(event):
            if event[7] == 'bad':
                raise GoogleError(400, 'Tasks')
            sent.append(event[7])
            return 'remote-' + event[7]
        with patch.object(self.bridge, 'deliver_task', side_effect=send):
            self.bridge.deliver('tasks')
        self.assertEqual(sent, ['good'])
        item = dict(self.feeding('bad'), amount='150ml')
        with self.store.connect() as db:
            self.bridge.queue(db, 'records', 'bad', item, 'delete')
        self.assertFalse(self.rows("SELECT * FROM google_delivery_retries WHERE target='tasks'"))
        with patch.object(self.bridge, 'deliver_task', return_value='remote-bad') as send:
            self.bridge.deliver('tasks')
        self.assertEqual(send.call_count, 1)
        self.assertEqual(send.call_args.args[0][5], 'delete')
        self.assertEqual(self.rows('SELECT COUNT(*) FROM google_record_events WHERE sheet_done=0'), [(3,)])

    def test_calendar_and_shopping_poison_jobs_are_skipped(self):
        self.queue('bad', 'good')
        def write(event_id, item, **kwargs):
            if item['id'] == 'bad':
                raise GoogleError(400, 'Calendar')
        with patch.object(self.bridge.calendar, 'write_event', side_effect=write) as send:
            self.bridge.calendar.flush()
            self.bridge.calendar.flush()
        self.assertEqual(send.call_count, 2)
        self.assertEqual(self.rows('SELECT item_id FROM google_calendar_jobs'), [('bad',)])
        with self.store.connect() as db:
            for item_id in ('bad', 'good'):
                self.bridge.shopping.queue(db, {'id': item_id, 'title': '기저귀'},
                                           {'id': item_id, 'title': '솜하우스 구매 기저귀'})
        def get_task(task_list, task_id):
            if task_id == 'bad':
                raise GoogleError(403, 'Tasks')
            return {'status': 'completed'}
        with patch.object(self.bridge.api, 'get_task', side_effect=get_task) as get:
            self.bridge.shopping.flush()
            self.bridge.shopping.flush()
        self.assertEqual(get.call_count, 2)
        self.assertEqual(self.rows('SELECT item_id,task_done FROM google_shopping_jobs ORDER BY item_id'), [('bad', 0), ('good', 1)])

    def test_edit_during_failed_calendar_send_keeps_new_revision_eligible(self):
        self.queue('a')
        def change(*args, **kwargs):
            with self.store.connect() as db:
                self.bridge.calendar.queue(db, 'records', 'a', dict(self.feeding('a'), amount='160ml'))
            raise GoogleError(500, 'Calendar')
        with patch.object(self.bridge.calendar, 'write_event', side_effect=change):
            self.bridge.calendar.flush()
        self.assertFalse(self.rows("SELECT * FROM google_delivery_retries WHERE target='calendar'"))
        with patch.object(self.bridge.calendar, 'write_event') as send:
            self.bridge.calendar.flush()
        self.assertEqual(send.call_args.args[1]['amount'], '160ml')

    def test_row_conflict_relocates_without_overwriting_or_duplicate(self):
        self.queue('a', 'b')
        events = self.rows('SELECT event_id FROM google_record_events ORDER BY seq')
        remote = {1: ['이벤트 ID'], 2: ['manual'], 3: [events[1][0]]}
        def read(cell):
            return [remote.get(i, []) for i in range(1, max(remote) + 1)] if cell == 'A:A' else remote.get(int(cell[1:]), [])
        def write(row, values):
            if row in remote and remote[row][0] != values[0]:
                raise GoogleError('원본 행 충돌', 'Sheets')
            remote[row] = values
        with patch.object(self.bridge.api, 'sheet_row', side_effect=write), patch.object(self.bridge.api, 'sheet_cell', side_effect=read):
            self.bridge.deliver('sheets')
        self.assertEqual(remote[2], ['manual'])
        self.assertEqual(remote[4][0], events[0][0])
        self.assertEqual(self.rows('SELECT sheet_done FROM google_record_events'), [(1,), (1,)])

    def test_lost_sheet_reply_then_sort_deduplicates_by_event_id(self):
        self.queue('a')
        event_id = self.rows('SELECT event_id FROM google_record_events')[0][0]
        with patch.object(self.bridge.api, 'sheet_row', side_effect=GoogleError('응답 유실', 'Sheets')):
            self.bridge.deliver('sheets')
        self.retry_now()
        with patch.object(self.bridge.api, 'sheet_cell', return_value=[['header'], [], [event_id]]), patch.object(self.bridge.api, 'sheet_row') as write:
            self.bridge.deliver('sheets')
        write.assert_not_called()
        self.assertEqual(self.rows('SELECT sheet_done FROM google_record_events'), [(1,)])

    def test_sheet_cache_recovers_after_rename_and_resize(self):
        api = GoogleAPI({'spreadsheet': 'sheet', 'source_sheet_id': 7})
        api.sheet_size = (7, 1000, 20)
        with patch.object(api, 'request', side_effect=GoogleError(400, 'Sheets')):
            with self.assertRaises(GoogleError):
                api.sheet_row(4, ['event'])
        self.assertIsNone(api.sheet_size)
        metadata = {'sheets': [{'properties': {'sheetId': 7, 'title': "이름'변경", 'gridProperties': {'rowCount': 2, 'columnCount': 10}}}]}
        with patch.object(api, 'sheet_metadata', return_value=metadata), patch.object(api, 'request', return_value={}) as request:
            api.sheet_row(4, ['event'])
        self.assertTrue(any(call.args[1:2] == ('POST',) for call in request.call_args_list))
        from urllib.parse import unquote
        self.assertIn("'이름''변경'!A4", unquote(request.call_args.args[0]))

    def test_source_protection_is_idempotent_and_sheet_id_survives_restart(self):
        properties = {'sheetId': 7, 'title': TAB, 'gridProperties': {'rowCount': 1000, 'columnCount': 20}}
        metadata = {'sheets': [{'properties': properties, 'protectedRanges': []}]}
        with patch.object(self.bridge.api, 'sheet_metadata', return_value=metadata), patch.object(self.bridge.api, 'request') as request:
            self.bridge.protect_source()
            protection = request.call_args.args[2]['requests'][0]['addProtectedRange']['protectedRange']
            self.assertTrue(protection['warningOnly'])
            metadata['sheets'][0]['protectedRanges'].append(protection)
            self.bridge.protect_source()
            self.assertEqual(request.call_count, 1)
        self.assertEqual(GoogleRecords(self.store, self.config).api.sheet_id, 7)

    def test_legacy_receipts_and_calendar_review_are_migrated_without_losing_events(self):
        from google_records import SCHEMA as RECORD_SCHEMA
        from calendar_records import SCHEMA as CALENDAR_SCHEMA
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'somhouse.sqlite3'
            with closing(sqlite3.connect(path)) as db, db:
                db.executescript(RECORD_SCHEMA + CALENDAR_SCHEMA)
                db.execute("INSERT INTO google_voice_receipts VALUES ('test','voice','fp',0)")
                db.execute("INSERT INTO google_calendar_inputs VALUES ('test','primary','event','item','fp',NULL)")
                for seq, source, voice in ((1, 'tasks', 'voice'), (2, 'calendar', '')):
                    db.execute("""INSERT INTO google_record_events
                        (seq,binding,sheet_row,event_id,captured,source,action,kind,item_id,voice_id,status,title,raw)
                        VALUES (?,'test',?,?,'2026-01-01T10:00:00+09:00',?,'import','records','item',?,'확인 필요','raw','{}')""",
                               (seq, seq + 1, str(seq), source, voice))
            migrated = Store(directory)
            Store(directory)
            with migrated.connect() as db:
                self.assertEqual(db.execute('SELECT captured FROM google_voice_receipts').fetchone()[0], '2026-01-01T10:00:00+09:00')
                self.assertEqual(db.execute('SELECT review FROM google_calendar_inputs').fetchone()[0], 1)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM google_record_events').fetchone()[0], 2)

    def test_invalid_grant_pauses_all_targets_until_new_credentials(self):
        self.queue('a', 'b')
        with patch.object(self.bridge.api, 'sheet_row', side_effect=GoogleAuthError()) as write:
            self.bridge.deliver('sheets')
        self.assertEqual(write.call_count, 1)
        self.assertEqual(self.bridge.auth_state, 'reconnect_required')
        self.assertFalse(self.rows('SELECT * FROM google_delivery_retries'))
        restarted = GoogleRecords(Store(self.temp.name), self.config)
        operation = Mock()
        restarted.attempt('Tasks', operation)
        operation.assert_not_called()
        reconnected = GoogleRecords(self.store, dict(self.config, refresh_token='new-fake'))
        self.assertEqual(reconnected.auth_state, 'ready')
        reconnected.attempt('Tasks', operation)
        operation.assert_called_once()

    def test_import_failure_backs_off_without_blocking_other_services(self):
        operation = Mock(side_effect=GoogleError(500, 'Tasks'))
        for _ in range(3):
            self.bridge.attempt('Tasks 음성 가져오기', operation)
        self.assertEqual(operation.call_count, 1)
        other = Mock()
        self.bridge.attempt('Sheets', other)
        other.assert_called_once()

    def test_personal_purchases_are_ignored_even_in_old_queue(self):
        for index, title in enumerate(('보험 구매', '아이패드 구입', '선물 구입하기')):
            self.bridge.record_voice({'id': str(index), 'title': title})
        self.assertFalse(self.rows('SELECT * FROM items'))
        self.assertFalse(self.rows('SELECT * FROM google_record_events'))
        self.assertIsNone(purchase_payload('기저귀 구매', 'x'))
        self.bridge.shopping.settings = {'products': {'기저귀': '예시 기저귀 4단계 52매'}}
        self.bridge.record_voice({'id': 'registered', 'title': '아기 기저기 구매'})
        self.assertEqual(len(self.rows('SELECT * FROM items')), 1)
        with self.store.connect() as db:
            self.bridge.shopping.queue(db, {'id': 'old', 'title': '보험'}, {'id': 'old', 'title': '보험 구매'})
        with patch.object(self.bridge.api, 'get_task', return_value={'status': 'completed'}) as get:
            self.bridge.shopping.flush()
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.args[1], 'registered')

    def test_corrected_task_preserves_initial_time_and_accepts_spoken_time(self):
        self.bridge.record_voice({'id': 'a', 'title': '솜하우스 수유 분유 조금', 'updated': '2026-01-01T01:00:00Z'})
        self.bridge.record_voice({'id': 'a', 'title': '솜하우스 수유 분유 120cc', 'updated': '2026-01-02T04:00:00Z'})
        item = json.loads(self.rows('SELECT body FROM items')[0][0])
        self.assertEqual(item['date'], '2026-01-01T10:00')
        self.assertEqual(item['amount'], '120ml')
        for title in ('솜하우스 수유 분유 120씨씨 오후 3시', '솜하우스 오후 3시 수유 분유 120 미리'):
            tagged, parsed = voice_payload(title, datetime(2026, 1, 1, tzinfo=SEOUL), 'b')
            self.assertTrue(tagged)
            self.assertEqual(parsed[1]['date'], '2026-01-01T15:00')
            self.assertEqual(parsed[1]['amount'], '120ml')
        self.assertEqual(voice_payload('솜하우스 수유 분유 120ml 오후 13시', datetime.now(SEOUL), 'c'), (True, None))

    def test_calendar_removing_tag_retracts_only_unedited_record_and_flags_future(self):
        event = {'id': 'a', 'summary': '솜하우스 수유 분유 120ml', 'start': {'dateTime': '2026-01-01T10:00:00+09:00'}}
        self.bridge.calendar.record(event)
        self.bridge.calendar.record(dict(event, summary='개인 일정'))
        self.assertFalse(self.rows('SELECT * FROM items'))
        other = dict(event, id='b')
        self.bridge.calendar.record(other)
        with self.store.connect() as db:
            item_id, body = db.execute('SELECT id,body FROM items').fetchone()
            db.execute('UPDATE items SET body=? WHERE id=?', (encode(dict(json.loads(body), amount='150ml')), item_id))
        self.bridge.calendar.record(dict(other, summary='개인 일정'))
        self.assertEqual(len(self.rows('SELECT * FROM items')), 1)
        future = dict(event, id='future', start={'dateTime': (datetime.now(SEOUL) + timedelta(days=2)).isoformat()})
        self.bridge.calendar.record(future)
        with self.store.connect() as db:
            self.assertEqual(self.bridge.status(db)['review'], 2)
        self.assertEqual(len(self.rows('SELECT * FROM items')), 1)

    def test_calendar_accepts_natural_assistant_phrases_and_reviews_misheard_ones(self):
        from calendar_records import calendar_feeding
        start = {'dateTime': '2026-11-16T22:12:02Z', 'timeZone': 'Asia/Seoul'}
        def parse(summary):
            return calendar_feeding({'summary': summary, 'start': start}, 'cal-x')
        for summary, category, amount in [
                ('100미리 수유', '기타', '100ml'), ('100미리 수유 캘린더에 업데이트', '기타', '100ml'),
                ('수유 100ml', '기타', '100ml'), ('분유 120미리 수유 기록', '분유', '120ml'),
                ('모유 수유 15분', '모유', '15분'), ('수유 100 밀리리터를 기록', '기타', '100ml'),
                ('솜하우스 100미리 수유', '기타', '100ml'), ('솜하우스 수유 분유 120ml', '분유', '120ml')]:
            tagged, item = parse(summary)
            self.assertTrue(tagged, summary)
            self.assertEqual((item['category'], item['amount'], item['date']),
                             (category, amount, '2026-11-17T07:12'), summary)
        # Common misrecognitions are corrected and saved; the memo keeps what Google wrote.
        for summary in ('수유 100mm', '수육 기록 1 100mm', '수유 기록 1 100미리', '수육 100미리'):
            tagged, item = parse(summary)
            self.assertEqual((tagged, item['amount'], item['memo']), (True, '100ml', '음성 원문: ' + summary), summary)
        self.assertEqual(parse('100미리 수유')[1]['memo'], '')
        # Unknown words, two amounts or two kinds are kept for review, never silently saved or dropped.
        for summary in ('수유 100미리 120미리', '분유 모유 100미리', '수유 100미리 병원', '솜하우스 수유', '수유 0미리'):
            self.assertEqual(parse(summary), (True, None), summary)
        # Ordinary personal events without a feeding amount stay out of the family records.
        for summary in ('수육 맛집', '수육 30분', '분유 사기 2통', '회의 10분', '수유실 위치', '2분유 구매', '솜하우스 병원 메모'):
            self.assertEqual(parse(summary), (False, None), summary)
        self.assertEqual(calendar_feeding({'summary': '100미리 수유', 'start': {'date': '2026-11-17'}}, 'x'),
                         (True, None))

    def test_lookalike_feeding_words_are_saved_and_flagged_until_the_kind_is_known(self):
        from calendar_records import calendar_feeding, learnable
        start = {'dateTime': '2026-11-17T07:12:00+09:00'}
        def parse(summary, aliases=None):
            return calendar_feeding({'summary': summary, 'start': start}, 'cal-x', aliases)
        # A spoken kind is final.
        for summary, kind in (('분유 120ml', '분유'), ('모유 수유 15분', '모유'), ('혼합 80미리', '혼합')):
            item = parse(summary)[1]
            self.assertEqual((item['category'], 'confirm' in item), (kind, False), summary)
        # No kind, or 수유 misheard: saved now, kind asked later, nothing to learn.
        for summary in ('수유 100ml', '100미리 수유 캘린더에 업데이트', '수육 100ml', '수육 기록 1 100mm'):
            item = parse(summary)[1]
            self.assertEqual((item['category'], item.get('confirm'), 'heard' in item), ('기타', 'category', False), summary)
        # A new look-alike of a kind word is saved, flagged, and offered for learning.
        for summary, word in (('부유 100ml', '부유'), ('머유 100미리', '머유'), ('부유 수유 100ml', '부유')):
            item = parse(summary)[1]
            self.assertEqual((item['category'], item['confirm'], item['heard'], item['amount']),
                             ('기타', 'category', word, '100ml'), summary)
            self.assertEqual(item['memo'], '음성 원문: ' + summary)
        # Once learned it is saved with its kind and no question; the memo still shows what was heard.
        item = parse('부유 100ml', {'부유': '분유'})[1]
        self.assertEqual((item['category'], 'confirm' in item, item['memo']), ('분유', False, '음성 원문: 부유 100ml'))
        # Two new words or two kinds stay in review; look-alikes without a volume are not feedings.
        for summary in ('부유 머유 100ml', '분유 모유 100ml'):
            self.assertEqual(parse(summary), (True, None), summary)
        self.assertEqual(parse('부유 100ml', {'부유': '분유', '머유': '모유'})[1]['category'], '분유')
        self.assertEqual(parse('부유 머유 100ml', {'부유': '분유', '머유': '모유'}), (True, None))
        for summary in ('수육 30분', '부유 30분', '교육 2시', '석유 가격'):
            self.assertEqual(parse(summary), (False, None), summary)
        self.assertEqual([learnable(w) for w in ('부유', '머유', '수육', '수유', '분유', '부', '부유물')],
                         [True, True, False, False, False, False, False])

    def test_calendar_edit_and_web_edit_of_different_fields_are_both_kept(self):
        event = {'id': 'm1', 'summary': '뷰유 10미리', 'created': '2026-01-01T05:01:00Z',
                 'start': {'dateTime': '2026-01-01T14:00:00+09:00'}}
        calendar = self.bridge.calendar
        calendar.record(event)
        def record():
            return json.loads(self.rows("SELECT body FROM items WHERE kind='records'")[0][0])
        def web(**changes):
            body = dict(record(), **changes)
            body.pop('confirm', None)
            with self.store.connect() as db:
                db.execute("UPDATE items SET body=? WHERE kind='records'", (encode(body),))
        self.assertEqual((record()['category'], record()['confirm']), ('기타', 'category'))
        # The kind is picked on the web; later the time is fixed in Calendar: both survive.
        web(category='분유')
        calendar.record(dict(event, start={'dateTime': '2026-01-01T13:30:00+09:00'}))
        self.assertEqual((record()['date'], record()['category'], 'confirm' in record()), ('2026-01-01T13:30', '분유', False))
        # The amount is fixed in Calendar as well.
        calendar.record(dict(event, summary='뷰유 30미리', start={'dateTime': '2026-01-01T13:30:00+09:00'}))
        self.assertEqual((record()['amount'], record()['category'], record()['date']), ('30ml', '분유', '2026-01-01T13:30'))
        with self.store.connect() as db:
            self.assertEqual(self.bridge.status(db)['review'], 0)
        # Both sides changing the same field differently is a real conflict: the web value stays, review is raised.
        web(amount='45ml')
        calendar.record(dict(event, summary='뷰유 60미리', start={'dateTime': '2026-01-01T13:30:00+09:00'}))
        self.assertEqual(record()['amount'], '45ml')
        with self.store.connect() as db:
            status = self.bridge.status(db)
        self.assertEqual((status['review'], status['review_items'][0]['status']), (1, '웹 기록 유지'))
        # Once Calendar agrees with the web value the conflict clears itself.
        calendar.record(dict(event, summary='뷰유 45미리', start={'dateTime': '2026-01-01T13:30:00+09:00'}))
        self.assertEqual(record()['amount'], '45ml')
        with self.store.connect() as db:
            self.assertEqual(self.bridge.status(db)['review'], 0)
        # A record deleted on the web is not brought back by a Calendar edit.
        with self.store.connect() as db:
            db.execute("DELETE FROM items")
        calendar.record(dict(event, summary='뷰유 50미리', start={'dateTime': '2026-01-01T13:30:00+09:00'}))
        self.assertFalse(self.rows("SELECT * FROM items"))

    def test_feeding_words_without_an_amount_wait_for_the_amount_instead_of_vanishing(self):
        from calendar_records import calendar_feeding
        start = {'dateTime': '2026-11-17T15:40:00+09:00'}
        def parse(summary, aliases=None):
            return calendar_feeding({'summary': summary, 'start': start}, 'cal-x', aliases)
        for summary in ('수유', '분유', '모유 수유', '분유 기록'):
            self.assertEqual(parse(summary), (True, None), summary)
        self.assertEqual(parse('뷰유', {'뷰유': '분유'}), (True, None))
        # A word nobody taught, or a feeding word inside an ordinary event, is still not ours.
        for summary in ('뷰유', '수육', '교육', '분유 사기', '수유실 위치', '모유 수유 교육', '분유 2통'):
            self.assertEqual(parse(summary), (False, None), summary)
        with self.store.connect() as db:
            db.execute("INSERT INTO feeding_aliases VALUES ('뷰유','분유')")
        self.bridge.calendar.record({'id': 'w1', 'summary': '뷰유', 'start': start})
        with self.store.connect() as db:
            status = self.bridge.status(db)
        self.assertEqual(status['review'], 1)
        self.assertEqual(status['review_items'][0]['suggest'], {'category': '분유', 'amount': ''})
        self.assertFalse(self.rows("SELECT * FROM items"))

    def test_hand_typed_calendar_events_use_the_time_they_were_entered(self):
        from calendar_records import calendar_feeding
        def parse(start, created='2026-11-17T04:10:30.000Z', summary='수유 100ml'):
            return calendar_feeding({'summary': summary, 'start': start, 'created': created}, 'cal-x')[1]
        # The Calendar app defaults a new event to the next slot: record it at the time it was typed (13:10 KST).
        item = parse({'dateTime': '2026-11-17T14:00:00+09:00'})
        self.assertEqual((item['date'], item['memo']), ('2026-11-17T13:10', '일정 시각 14:00 대신 입력한 시각으로 저장'))
        # An all-day event created on that day is also "just now".
        item = parse({'date': '2026-11-17'})
        self.assertEqual((item['date'], item['memo']), ('2026-11-17T13:10', '종일 일정이라 입력한 시각으로 저장'))
        # A start in the past (a feeding logged afterwards, or Nest's spoken time) is kept as entered.
        item = parse({'dateTime': '2026-11-17T11:30:00+09:00'})
        self.assertEqual((item['date'], item['memo']), ('2026-11-17T11:30', ''))
        # Corrections keep both notes.
        item = parse({'dateTime': '2026-11-17T14:00:00+09:00'}, summary='수육 100mm')
        self.assertEqual(item['memo'], '음성 원문: 수육 100mm · 일정 시각 14:00 대신 입력한 시각으로 저장')
        item = parse({'dateTime': '2026-11-17T14:00:00+09:00'}, summary='솜하우스 수유 분유 120ml')
        self.assertEqual((item['date'], item['category']), ('2026-11-17T13:10', '분유'))
        # More than two hours ahead is a plan, and an all-day event for another day has no usable time.
        self.assertEqual(parse({'dateTime': '2026-11-17T15:10:31+09:00'})['date'], '2026-11-17T15:10')
        self.assertIsNone(parse({'date': '2026-11-18'}))
        self.assertIsNone(parse({'date': '2026-11-17'}, created=None))

    def test_planned_feeding_far_ahead_stays_in_review_and_quick_entry_is_saved(self):
        now = datetime.now(SEOUL)
        created = (now - timedelta(minutes=1)).isoformat()
        self.bridge.calendar.record({'id': 'soon', 'summary': '분유 120미리 수유', 'created': created,
                                     'start': {'dateTime': (now + timedelta(minutes=40)).isoformat()}})
        self.bridge.calendar.record({'id': 'plan', 'summary': '분유 120미리 수유', 'created': created,
                                     'start': {'dateTime': (now + timedelta(hours=5)).isoformat()}})
        items = [json.loads(body) for (body,) in self.rows("SELECT body FROM items WHERE kind='records'")]
        self.assertEqual([x['date'] for x in items], [(now - timedelta(minutes=1)).replace(tzinfo=None).isoformat(timespec='minutes')])
        with self.store.connect() as db:
            self.assertEqual(self.bridge.status(db)['review'], 1)

    def test_natural_calendar_feeding_is_imported_once_and_unclear_one_is_counted_for_review(self):
        start = {'dateTime': '2026-01-01T07:12:00+09:00'}
        self.bridge.calendar.record({'id': 'n1', 'summary': '100미리 수유 캘린더에 업데이트', 'start': start})
        self.bridge.calendar.record({'id': 'n1', 'summary': '100미리 수유 캘린더에 업데이트', 'start': start})
        self.bridge.calendar.record({'id': 'n2', 'summary': '수육 기록 1 100mm', 'start': start})
        self.bridge.calendar.record({'id': 'n3', 'summary': '수육 맛집', 'start': start})
        self.bridge.calendar.record({'id': 'n4', 'summary': '수유 100미리 병원', 'start': start})
        items = [json.loads(body) for (body,) in self.rows("SELECT body FROM items WHERE kind='records'")]
        self.assertEqual([(x['date'], x['amount'], x['memo']) for x in items],
                         [('2026-01-01T07:12', '100ml', ''), ('2026-01-01T07:12', '100ml', '음성 원문: 수육 기록 1 100mm')])
        with self.store.connect() as db:
            self.assertEqual(self.bridge.status(db)['review'], 1)
        statuses = [row[0] for row in self.rows("SELECT status FROM google_record_events WHERE source='calendar' ORDER BY seq")]
        self.assertEqual(statuses, ['저장', '저장', '확인 필요'])

    def test_backfill_is_explicit_and_idempotent_by_item_and_content(self):
        with self.store.connect() as db:
            db.execute("INSERT INTO items VALUES ('records','a',?)", (encode(self.feeding('a')),))
        self.assertFalse(self.rows('SELECT * FROM google_record_events'))
        with self.store.connect() as db:
            self.assertEqual(self.bridge.backfill(db), 1)
            self.assertEqual(self.bridge.backfill(db), 0)
            db.execute("UPDATE items SET body=? WHERE id='a'", (encode(dict(self.feeding('a'), amount='150ml')),))
            self.assertEqual(self.bridge.backfill(db), 1)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM google_record_events'), [(2,)])

    def test_admin_status_backfill_and_retry_commands_use_persisted_state(self):
        config = dict(self.config, ready=True, client_id='fake-client', client_secret='fake-secret', subject='fake-user')
        save_config(Path(self.temp.name), config)
        bridge = GoogleRecords(self.store, config)
        bridge.require_reconnect()
        with self.store.connect() as db:
            db.execute("INSERT INTO items VALUES ('records','a',?)", (encode(self.feeding('a')),))
        def command(name):
            result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'server.py'),
                                     name, '--data-dir', self.temp.name], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('fake-secret', result.stdout)
            return result.stdout
        self.assertIn('재연결 필요', command('google-status'))
        self.assertIn('1건', command('google-backfill'))
        self.assertIn('0건', command('google-backfill'))
        with self.store.connect() as db:
            from google_delivery import failure
            failure(db, 'test', 'sheets', 1, 'Sheets 400')
        self.assertIn('1건', command('google-retry'))
        self.assertIn('재연결 필요', command('google-status'))
        self.assertFalse(self.rows('SELECT * FROM google_delivery_retries'))

    def test_admin_delete_record_backs_up_first_and_only_notifies_google_when_sent(self):
        config = dict(self.config, ready=True, client_id='fake-client', client_secret='fake-secret', subject='fake-user')
        save_config(Path(self.temp.name), config)
        with self.store.connect() as db:
            for item_id in ('local', 'sent'):
                db.execute("INSERT INTO items VALUES ('records',?,?)", (item_id, encode(self.feeding(item_id))))
            self.bridge.queue(db, 'records', 'sent', self.feeding('sent'), 'save')

        def delete(item_id):
            return subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'server.py'),
                                   'delete-record', '--kind', 'records', '--item-id', item_id,
                                   '--data-dir', self.temp.name], capture_output=True, text=True, timeout=10)

        before = self.rows('SELECT COUNT(*) FROM google_record_events')[0][0]
        result = delete('local')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('외부에 남는 흔적은 없습니다', result.stdout)
        self.assertNotIn('fake-secret', result.stdout)
        backup = Path(result.stdout.split('삭제 전 관리자 백업: ')[1].split()[0])
        self.assertEqual({x['id'] for x in json.loads(backup.read_text())['records']}, {'local', 'sent'})
        self.assertFalse(backup.name.startswith('auto-'))
        self.assertEqual(self.rows('SELECT COUNT(*) FROM google_record_events')[0][0], before)

        result = delete('sent')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Google 사본에도 삭제', result.stdout)
        self.assertEqual(self.rows("SELECT action FROM google_record_events WHERE item_id='sent' ORDER BY seq"),
                         [('save',), ('delete',)])
        self.assertFalse(self.rows("SELECT * FROM items"))
        missing = delete('sent')
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn('해당 기록이 없습니다', missing.stderr)

    def test_backup_retention_preserves_manual_and_legacy_files(self):
        with self.store.connect() as db:
            manual = self.store.snapshot(db, automatic=False)
            folder = manual.parent
            legacy = folder / '20200101-010101-abcdef123456.json'
            legacy.write_text('{}')
            for index in range(120):
                path = folder / f'auto-20200101-010101-{index:012x}.json'
                path.write_text('{}')
                os.utime(path, (index + 100, index + 100))
            newest = self.store.snapshot(db)
        self.assertTrue(manual.exists() and legacy.exists() and newest.exists())
        self.assertEqual(len(list(folder.glob('auto-*.json'))), 100)

    def test_unsafe_google_config_logs_and_never_falls_back_to_keep(self):
        path = Path(self.temp.name) / 'google-records.json'
        path.write_text('{}')
        path.chmod(0o644)
        with patch('server.KeepSync.load') as keep, patch('sys.stderr', new_callable=io.StringIO) as output:
            server = FamilyServer(('127.0.0.1', 0), self.store)
            server.server_close()
        keep.assert_not_called()
        self.assertIn('0600', output.getvalue())


class PriceRegression(unittest.TestCase):
    def test_weight_range_and_single_pack_are_allowed_but_conflicting_specs_are_not(self):
        query = '예시브랜드 기저귀 4단계 52매'
        self.assertTrue(matches_price(query, {'title': query.replace('4단계', '4단계(12~17kg)') + ' 1팩'}))
        for title in ('예시브랜드 기저귀 5단계 52매', query + ' 2팩', query + 'x10', query + ' 40매', query + ' 세트'):
            self.assertFalse(matches_price(query, {'title': title}), title)
        self.assertEqual(choose_price(query, [{'title': query, 'price': '₩12,900부터', 'extracted_price': 12900,
                                             'link': 'https://example.com/a'}])['price_krw'], 12900)
        self.assertIsNone(choose_price(query, [{'title': query, 'price': '$5', 'extracted_price': 5,
                                              'link': 'https://example.com/a'}]))


class TransportRegression(unittest.TestCase):
    def test_real_http_error_distinguishes_revoked_token_and_normal_bad_request(self):
        class OAuth(BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'invalid_grant' if self.path == '/revoked' else 'invalid_request',
                                            'error_description': 'must not be logged'}).encode())
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), OAuth)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f'http://127.0.0.1:{server.server_port}'
            with self.assertRaises(GoogleAuthError) as revoked:
                json_request(base + '/revoked', 'POST', b'', service='OAuth')
            self.assertNotIn('must not be logged', str(revoked.exception))
            with self.assertRaises(GoogleError) as ordinary:
                json_request(base + '/bad', 'POST', b'', service='OAuth')
            self.assertEqual(ordinary.exception.status, 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
