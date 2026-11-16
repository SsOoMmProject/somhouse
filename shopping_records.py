"""Enrich explicitly requested Google shopping tasks without placing orders."""
import json
import math
import re
import unicodedata
from html import unescape
from urllib.parse import urlencode, urlsplit

from google_records import GoogleError, PREFIX, encode, json_request, now_seoul, queue_event
from google_delivery import eligible


CONFIG_NAME = "shopping-search.json"
SEARCH_API = "https://serpapi.com/search.json"
BLOCK = "[솜하우스 가격비교]"
BLOCK_END = "[/솜하우스 가격비교]"
SPEC = re.compile(r"(?<!\d)(\d+)\s*(단계|매|장|개|팩|kg|ml|g|l)(?![a-z])", re.IGNORECASE)
MULTIPACK = re.compile(r"(?<!\d)([2-9]|\d{2,})\s*팩|[x×]\s*(?:[2-9]|\d{2,})(?!\d)|(?:묶음|세트|박스)")
PRICE = re.compile(r"(?:₩|KRW)\s*(\d[\d,]*)|(\d[\d,]*)\s*원", re.IGNORECASE)
SCHEMA = """
CREATE TABLE IF NOT EXISTS google_shopping_jobs (
    binding TEXT NOT NULL, item_id TEXT NOT NULL, task_list TEXT NOT NULL, task_id TEXT NOT NULL,
    original_title TEXT NOT NULL, query TEXT NOT NULL, result TEXT, task_done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (binding,item_id)
);
"""


def normalize(text):
    return " ".join(unicodedata.normalize("NFKC", text).replace("기저기", "기저귀").split())


def purchase_payload(title, item_id, settings=None):
    text = normalize(title).rstrip(" .!?")
    prefix = PREFIX.match(text)
    if prefix:
        match = re.fullmatch(r"(?:구매|장보기)\s*[:：]?\s+(.+?)(?:\s+수량\s+(.+))?", text[prefix.end():])
        if not match:
            return None
        product, quantity = match[1], match[2] or "미정"
    else:
        match = re.fullmatch(r"(.+?)\s+(?:구매|구입)(?:하기)?(?:\s*(?:할\s*일\s*)?추가(?:해\s*줘)?)?", text)
        if not match:
            return None
        product, quantity = match[1], "미정"
        presets = (settings or {}).get("products", {})
        alias = re.sub(r"^(?:아기|유아)\s+", "", product)
        if not isinstance(presets, dict) or not any(
            normalize(key) in (product, alias) and isinstance(value, str) and value.strip()
            for key, value in presets.items()
        ):
            return None
    if len(product) > 160 or product.startswith(("솜하우스 ", "헤이 구글 ")):
        return None
    return {"id": item_id, "title": product, "quantity": quantity, "done": "no", "url": search_link(product)}


def search_link(query):
    return "https://www.google.com/search?" + urlencode({"tbm": "shop", "q": query, "hl": "ko", "gl": "kr"})


def load_shopping_config(directory):
    path = directory / CONFIG_NAME
    try:
        if path.stat().st_mode & 0o077:
            return {}
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def specs(text):
    units = {"장": "매"}
    return {(int(n), units.get(unit.lower(), unit.lower())) for n, unit in SPEC.findall(text)}


def matches_price(query, result):
    raw_title = result.get("title")
    if not isinstance(raw_title, str) or result.get("second_hand_condition") or result.get("installment"):
        return False
    title = normalize(unescape(raw_title)).lower()
    query = normalize(query).lower()
    expected = specs(query) - {(1, "팩")}
    candidate = specs(title) - {(1, "팩")}
    # Additional weight guidance is fine. Conflicting stage/count/volume is not.
    compared_units = {unit for _, unit in expected} | {"단계", "매", "개", "팩"}
    if (not expected <= candidate or {spec for spec in candidate if spec[1] in compared_units} != expected
            or (MULTIPACK.search(title) and not MULTIPACK.search(query))):
        return False
    if "기저귀" in query and re.search(
        r"성인(?:용|\s|기저귀)|강아지|(?<![가-힣])(?:샘플|샘플용|체험분|체험팩|커버)(?![가-힣])", title
    ):
        return False
    # Retain named product/variant words after removing generic descriptors and parsed size/count.
    words = re.findall(r"[가-힣a-z0-9]+", SPEC.sub(" ", query))
    for word in words:
        if word in {"아기", "유아", "신생아용"}:
            continue
        if word.isascii():
            if not re.search(r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])", title):
                return False
        elif word not in title:
            return False
    return True


def has_specification(query):
    attributes = {unit for _, unit in specs(query)}
    terms = set(re.findall(r"[가-힣a-z0-9]+", SPEC.sub(" ", query.lower())))
    if "기저귀" in query:
        generic = {"아기", "유아", "기저귀", "팬티형", "밴드형", "신생아", "신생아용", "팬티", "밴드"}
        return {"단계", "매"} <= attributes and bool(terms - generic)
    return bool(attributes) and len(terms) >= 2


def choose_price(query, items):
    matches = {}
    for item in items:
        if not isinstance(item, dict) or not matches_price(query, item):
            continue
        price = PRICE.fullmatch(normalize(str(item.get("price", ""))))
        link = item.get("product_link") or item.get("link")
        if not isinstance(link, str) or len(link) > 2048:
            continue
        try:
            url = urlsplit(link)
            extracted = item.get("extracted_price")
            # extracted_price has no currency; never interpret a dollar amount as KRW.
            price_text = str(item.get("price", ""))
            krw = (bool(price) or bool(re.search(r"₩|KRW|원", price_text))) and not re.search(r"[$€£¥]|USD|EUR|JPY", price_text)
            krw = krw or (not price_text and item.get("currency") == "KRW")
            if not krw:
                continue
            number = (extracted if type(extracted) in (int, float) and math.isfinite(extracted)
                      and extracted > 0 and float(extracted).is_integer()
                      else int((price[1] or price[2]).replace(",", "")) if price else 0)
        except ValueError:
            continue
        if url.scheme != "https" or not url.hostname or url.username or url.password or not number:
            continue
        if link in matches and matches[link]["price_krw"] <= number:
            continue
        matches[link] = {"price_krw": int(number), "link": link, "product": item["title"][:300],
                         "seller": str(item.get("source", ""))[:100]}
    if not matches:
        return None
    result = min(matches.values(), key=lambda item: item["price_krw"])
    return {**result, "count": len(matches)}


def compare(query, settings):
    presets = settings.get("products")
    alias = re.sub(r"^(?:아기|유아)\s+", "", query)
    custom = (presets.get(query) or presets.get(alias)) if isinstance(presets, dict) else None
    term = normalize(custom) if isinstance(custom, str) and len(custom.strip()) <= 160 and custom.strip() else query
    search = search_link(term)
    result = {"query": term, "search": search, "link": search, "checked": now_seoul().isoformat(timespec="minutes")}
    key = settings.get("serpapi_key")
    if not has_specification(term):
        return {**result, "status": "규격 확인 필요"}
    if not isinstance(key, str) or not key.strip():
        return {**result, "status": "가격 검색 설정 필요"}
    params = {"engine": "google_shopping", "q": term, "google_domain": "google.co.kr",
              "hl": "ko", "gl": "kr", "api_key": key.strip()}
    response = json_request(f"{SEARCH_API}?{urlencode(params)}", "GET", service="가격 검색")
    if response.get("error"):
        raise GoogleError("검색 오류", "가격 검색")
    offers = response.get("shopping_results") or []
    best = choose_price(term, offers[:50]) if isinstance(offers, list) else None
    return {**result, **best, "status": "비교 결과"} if best else {**result, "status": "동일 규격 상품을 찾지 못함"}


def shopping_notes(notes, result):
    notes = notes if isinstance(notes, str) else ""
    prior = re.search(r"(?:\n\n|^)" + re.escape(BLOCK) + r"\n.*?\n" + re.escape(BLOCK_END) + r"$",
                      notes, flags=re.DOTALL)
    if prior:
        notes = notes[:prior.start()]
    lines = [BLOCK, f"검색어: {result['query']}"]
    if result.get("price_krw"):
        lines += [f"동일 규격 검색 결과 {result['count']}개 중 최저 표시가: {result['price_krw']:,}원",
                  result["product"], f"{result['seller']} {result['link']}".strip(),
                  f"조회 시각: {result['checked']} · 배송비·쿠폰·선택 옵션은 결제 전에 확인"]
    else:
        lines.append(result["status"])
        if result["status"] == "규격 확인 필요":
            lines.append("브랜드·상품명·사이즈·포장 수량을 확인해 주세요.")
    lines.extend([f"가격비교: {result['search']}", BLOCK_END])
    updated = (notes + "\n\n" if notes else "") + "\n".join(lines)
    # Avoid overwriting notes when Google Tasks has no space for the managed section.
    return updated if len(updated.encode("utf-16-le")) // 2 <= 8192 else None


class ShoppingRecords:
    def __init__(self, records):
        self.records, self.store = records, records.store
        self.binding = records.binding
        self.settings = load_shopping_config(self.store.directory)

    def queue(self, db, item, task):
        db.execute("""
            INSERT OR IGNORE INTO google_shopping_jobs
            (binding,item_id,task_list,task_id,original_title,query) VALUES (?,?,?,?,?,?)
        """, (self.binding, item["id"], self.records.config["inbox"], task["id"], task["title"], item["title"]))

    def flush(self):
        with self.store.connect() as db:
            jobs = db.execute(f"""
                SELECT item_id,task_list,task_id,original_title,query,result FROM google_shopping_jobs
                AS j WHERE binding=? AND task_done=0 AND {eligible('j', 'shopping', 'j.item_id')}
                ORDER BY rowid LIMIT 5
            """, (self.binding,)).fetchall()
        for item_id, task_list, task_id, original_title, query, saved in jobs:
            if self.records.stop.is_set():
                return
            self.records.job("shopping", item_id,
                             lambda: self.deliver(item_id, task_list, task_id, original_title, query, saved))

    def deliver(self, item_id, task_list, task_id, original_title, query, saved):
        # Older queues may contain untagged personal tasks accepted before the policy fix.
        if not purchase_payload(original_title, item_id, self.settings):
            with self.store.lock, self.store.connect() as db:
                db.execute("UPDATE google_shopping_jobs SET task_done=1 WHERE binding=? AND item_id=?", (self.binding, item_id))
            return
        try:
            api = self.records.api
            task = api.get_task(task_list, task_id)
            if not task.get("deleted") and task.get("status") != "completed" and task.get("title") == original_title:
                result = json.loads(saved) if saved else self.store_result(item_id, query, task_id)
                if result:
                    updated = shopping_notes(task.get("notes"), result)
                    if updated and updated != task.get("notes"):
                        api.put_task(task_list, {"notes": updated}, task_id, etag=task.get("etag"))
                    elif updated is None:
                        raise GoogleError("메모 공간 부족", "Tasks")
        except GoogleError as error:
            if error.status not in (404, 410):
                raise
        with self.store.lock, self.store.connect() as db:
            db.execute("UPDATE google_shopping_jobs SET task_done=1 WHERE binding=? AND item_id=?",
                       (self.binding, item_id))

    def store_result(self, item_id, query, task_id):
        with self.store.connect() as db:
            exists = db.execute("SELECT 1 FROM items WHERE kind='shopping' AND id=?", (item_id,)).fetchone()
        if not exists:
            return None
        result = compare(query, self.settings)
        with self.store.lock, self.store.connect() as db:
            row = db.execute("SELECT body FROM items WHERE kind='shopping' AND id=?", (item_id,)).fetchone()
            if not row:
                return None
            item = json.loads(row[0])
            if item["title"] == query and item.get("url", "") in ("", search_link(query)):
                item["url"] = result["link"]
                db.execute("UPDATE items SET body=? WHERE kind='shopping' AND id=?", (encode(item), item_id))
            queue_event(db, self.binding, "shopping", item_id, result, source="shopping", action="price",
                        voice_id=task_id, title=query, status=result["status"], skip_task=True)
            db.execute("UPDATE google_shopping_jobs SET result=? WHERE binding=? AND item_id=?",
                       (encode(result), self.binding, item_id))
        return result
