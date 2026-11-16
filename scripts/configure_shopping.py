"""Set product presets and optional price search access for voice shopping."""
import argparse
import getpass
import os
from pathlib import Path
import re
import sys
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from google_records import save_config
from server import DEFAULT_DATA
from shopping_records import CONFIG_NAME, has_specification, load_shopping_config, normalize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--alias", help="음성에서 말할 상품 별칭, 예: 기저귀")
    parser.add_argument("--product", help="가격을 비교할 상세 상품명과 규격")
    parser.add_argument("--set-key", action="store_true", help="숨김 입력으로 SerpApi 키 등록")
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    if bool(args.alias) != bool(args.product) or not (args.alias or args.set_key):
        parser.error("--alias와 --product를 함께 지정하거나 --set-key로 검색 키를 등록하세요.")

    os.umask(0o077)
    settings = load_shopping_config(args.data_dir)
    if args.alias:
        alias, product = normalize(args.alias), normalize(args.product)
        if not alias or not product or len(alias) > 160 or len(product) > 160 or not has_specification(product):
            parser.error("비교할 브랜드·상품명·단계·포장 매수를 구체적으로 입력해 주세요.")
        presets = settings.get("products")
        settings["products"] = {**(presets if isinstance(presets, dict) else {}), alias: product}
    if args.set_key:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("SerpApi 키: ").strip()
        except (getpass.GetPassWarning, EOFError, KeyboardInterrupt):
            parser.exit(1, "키 등록을 취소했습니다. 숨김 입력을 지원하는 터미널에서 다시 실행하세요.\n")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{16,256}", key):
            parser.error("SerpApi 키 형식을 확인해 주세요.")
        settings["serpapi_key"] = key
    args.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    save_config(args.data_dir, settings, filename=CONFIG_NAME)
    print("장보기 설정을 저장했습니다. 서버를 재시작하면 새 할 일에 적용됩니다.")


if __name__ == "__main__":
    main()
