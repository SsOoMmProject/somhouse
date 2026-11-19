"""Made-up family records shown to the read-only guest account. No real family data is ever used here."""
from datetime import datetime, timedelta

GUEST = "guest"
READ_ONLY_MESSAGE = "게스트 계정은 볼 수만 있어요. 추가·수정·삭제는 가족 계정에서 할 수 있어요."

# (hour, minute, category, amount) repeated every day; times later than "now" are skipped for today.
FEEDINGS = ((1, 40, "분유", "120ml"), (5, 10, "모유", "15분"), (8, 30, "분유", "140ml"),
            (11, 50, "분유", "120ml"), (15, 20, "혼합", "100ml"), (18, 40, "분유", "140ml"),
            (21, 30, "모유", "20분"))


def demo_payload(now=None):
    """Records relative to `now`, so the guest always sees a lively today, this week and month."""
    now = (now or datetime.now()).replace(second=0, microsecond=0)
    stamp = lambda value: value.strftime("%Y-%m-%dT%H:%M")
    today = now.replace(hour=0, minute=0)
    records, schedule, shopping = [], [], []

    for back in range(14):
        day = today - timedelta(days=back)
        for index, (hour, minute, category, amount) in enumerate(FEEDINGS):
            when = day.replace(hour=hour, minute=minute)
            if when > now or (back % 3 == 1 and index == 3):
                continue
            records.append({"id": f"demo-feed-{back}-{index}", "type": "feeding", "date": stamp(when),
                            "category": category, "amount": amount,
                            "memo": "잘 먹고 트림까지 했어요" if index == 2 and back % 4 == 0 else ""})
        nap = day.replace(hour=13, minute=10)
        if nap + timedelta(minutes=50) <= now:
            records.append({"id": f"demo-nap-{back}", "type": "sleep", "date": stamp(nap),
                            "end": stamp(nap + timedelta(minutes=50 + back % 3 * 10)), "category": "낮잠", "memo": ""})
        night = day.replace(hour=22, minute=0) - timedelta(days=1)
        wake = night + timedelta(hours=6, minutes=30)
        records.append({"id": f"demo-night-{back}", "type": "sleep", "date": stamp(night),
                        "end": stamp(wake) if wake <= now else "",
                        "category": "밤잠", "memo": ""})

    # Inputs from voice or Calendar whose kind is not settled yet, shown in the home confirmation box.
    unsure = now - timedelta(minutes=50)
    records.append({"id": "demo-unsure-feed", "type": "feeding", "date": stamp(unsure), "category": "기타",
                    "amount": "90ml", "confirm": "category", "heard": "부유", "memo": "음성 원문: 부유 90미리"})
    records.append({"id": "demo-unsure-sleep", "type": "sleep", "date": stamp(unsure - timedelta(hours=3)),
                    "end": stamp(unsure - timedelta(hours=2, minutes=20)), "category": "낮잠",
                    "confirm": "category", "memo": "캘린더 원문: 수면"})
    for back, reason, memo in ((20, "2개월 예방접종", "다음 접종은 2개월 뒤"), (6, "기침 진료", "시럽 3일분")):
        records.append({"id": f"demo-hospital-{back}", "type": "hospital",
                        "date": stamp(today - timedelta(days=back) + timedelta(hours=10, minutes=30)),
                        "hospital": "예시소아과", "reason": reason, "memo": memo})

    for offset, hour, who, title, memo in ((-3, 15, "엄마", "산후 검진", ""), (0, 19, "가족", "할머니댁 영상통화", ""),
                                           (1, 10, "하늘", "영유아 검진 예약", "건강수첩 챙기기"),
                                           (4, 14, "아빠", "카시트 설치 점검", ""), (12, 11, "하늘", "예방접종", "")):
        schedule.append({"id": f"demo-plan-{offset}", "date": stamp(today + timedelta(days=offset, hours=hour)),
                         "who": who, "title": title, "memo": memo})

    for index, (title, quantity, done, offset, memo) in enumerate((
            ("기저귀 밴드형 3단계", "2팩", "no", 1, "가격 비교 링크는 음성 장보기 연결 시 표시돼요"),
            ("분유 800g", "1통", "no", 3, ""), ("물티슈 캡형", "10개", "yes", -2, ""),
            ("손수건", "5장", "no", None, ""))):
        shopping.append({"id": f"demo-shop-{index}", "title": title, "quantity": quantity, "done": done,
                         "date": (today + timedelta(days=offset)).strftime("%Y-%m-%d") if offset is not None else "",
                         "memo": memo, "url": ""})

    calendar_events = [
        {"id": "demo-gcal-1", "date": stamp(today + timedelta(days=2, hours=18)),
         "end": stamp(today + timedelta(days=2, hours=20)), "allDay": False, "title": "(예시) 가족 저녁 약속", "link": ""},
        {"id": "demo-gcal-2", "date": (today + timedelta(days=6)).strftime("%Y-%m-%d"),
         "end": (today + timedelta(days=6)).strftime("%Y-%m-%d"), "allDay": True, "title": "(예시) 이모 생일", "link": ""},
    ]
    last = stamp(now - timedelta(minutes=2)) + ":00"
    services = {name: {"pending": 0, "failed": 0, "retrying": 0, "last_success": last, "last_error": ""}
                for name in ("sheets", "tasks", "calendar", "shopping")}
    google_status = {"auth_state": "ready", "services": services, "review": 1, "errors": [], "review_items": [
        {"key": "demo:review-1", "source": "Tasks", "title": "솜하우스 수유 분유", "when": stamp(now - timedelta(hours=1)),
         "status": "확인 필요", "suggest": {"category": "분유", "amount": ""}}]}
    return {"data": {"records": records, "schedule": schedule, "shopping": shopping},
            "aliases": {"부유": "분유"}, "settings": {"children": ["하늘"]}, "calendar_events": calendar_events,
            # No Google links: on a phone they would open whatever Google account that phone is signed in to.
            "google_status": google_status, "read_only": True}
