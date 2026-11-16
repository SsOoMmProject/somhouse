"""Exercise Keep copy reconciliation without credentials or network access."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from keep_sync import PROBE, client_run, mirror


class Note:
    def __init__(self, note_id, title, text):
        self.id, self.title, self.text = note_id, title, text
        self.trashed = self.deleted = False

    def trash(self):
        self.trashed = True

    def untrash(self):
        self.trashed = False


class Client:
    def __init__(self):
        self.notes = {}
        self.syncs = []

    def get(self, note_id):
        return self.notes.get(note_id)

    def all(self):
        return list(self.notes.values())

    def createNote(self, title, text):
        note = Note(str(len(self.notes) + 1), title, text)
        self.notes[note.id] = note
        return note

    def sync(self, resync=False):
        self.syncs.append({note.id: note.trashed for note in self.all()})

    def authenticate(self, email, credential):
        self.auth = email, credential


class KeepCopy(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.entry = {"kind": "records", "item": dict(PROBE, memo="메모"), "marker": "a" * 32, "note_ids": {}}
        self.enterContext(patch.dict(sys.modules, {
            "gkeepapi": SimpleNamespace(Keep=lambda: self.client),
            "gkeepapi.node": SimpleNamespace(Note=Note),
        }))

    def test_recover_after_lost_acknowledgment_and_keep_unrelated_notes(self):
        personal = self.client.createNote("개인 메모", "유지")
        ids, = mirror(self.client, [self.entry])
        note = self.client.get(ids["1"])
        self.assertEqual(mirror(self.client, [self.entry]), [ids])
        self.assertEqual(len(self.client.all()), 2)
        duplicate = self.client.createNote(note.title, note.text)

        note.text = "Keep에서 표식을 지운 내용"
        new = dict(self.entry, item=dict(self.entry["item"], amount="130ml", extra="내보내지 않는 필드"),
                   note_ids=ids)
        self.assertEqual(mirror(self.client, [new]), [ids])
        self.assertIn("130ml", note.text)
        self.assertNotIn("내보내지 않는 필드", note.text)
        mirror(self.client, [dict(new, item=None)])
        self.assertTrue(note.trashed)
        self.assertFalse(duplicate.trashed)
        note.deleted = True  # Permanently purging the original still doesn't target a manual copy.
        mirror(self.client, [dict(new, item=None)])
        self.assertFalse(duplicate.trashed)
        replacement, = mirror(self.client, [new])
        self.assertNotEqual(replacement, ids)
        self.assertEqual(mirror(self.client, [new]), [replacement])
        self.assertEqual((personal.text, personal.trashed), ("유지", False))

    def test_long_unicode_notes_shrink_without_leaving_active_parts(self):
        long = dict(self.entry, item=dict(self.entry["item"], memo="🍼" * 10000))
        ids, = mirror(self.client, [long])
        self.assertGreater(len(ids), 2)
        content = [self.client.get(note_id).text.rsplit("\n\n", 1)[0] for note_id in ids.values()]
        self.assertTrue(all(len(text.encode("utf-16-le")) // 2 <= 8000 for text in content))
        self.assertEqual("".join(content).count("🍼"), 10000)

        mirror(self.client, [dict(self.entry, note_ids=ids)])
        self.assertFalse(self.client.get(ids["1"]).trashed)
        self.assertTrue(all(self.client.get(note_id).trashed for note_id in list(ids.values())[1:]))
        self.assertEqual(mirror(self.client, [dict(long, note_ids=ids)]), [ids])
        self.assertTrue(all(not self.client.get(note_id).trashed for note_id in ids.values()))

    def test_connection_probe_reads_its_note_and_cleans_up(self):
        with patch("keep_sync.read_credential", return_value="test-only-token"):
            ids, = client_run("test@example.com", [dict(self.entry, item=PROBE)], verify=True)
        note = self.client.get(ids["1"])
        self.assertIn("120ml", note.text)
        self.assertEqual(self.client.syncs, [{note.id: False}, {note.id: False}, {note.id: True}])
