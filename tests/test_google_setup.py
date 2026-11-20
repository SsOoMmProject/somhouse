"""google_setup.provision: create, reuse, and (on a reconnect) remake deleted Google resources."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from google_records import HEADERS, GoogleError
from google_setup import provision


class FakeGoogle:
    """Just enough of GoogleAPI: resources exist in sets, a missing one answers 404."""

    def __init__(self, config):
        self.config, self.sheet_id, self.sheet_size = config, None, None
        self.lists, self.sheets, self.calendars, self.trashed = {"@default"}, set(), {"primary"}, set()
        self.header, self.created = {}, []

    def tasks(self, task_list, updated_min=None):
        if task_list not in self.lists:
            raise GoogleError(404, "Tasks")
        return iter(())

    def request(self, url, method="GET", body=None, service="Google"):
        if "drive/v3/files/" in url:
            sheet = url.split("files/")[1].split("?")[0]
            if sheet not in self.sheets:
                raise GoogleError(404, "Drive")
            return {"trashed": sheet in self.trashed}
        if method == "POST":
            name = {"Tasks": "list", "Sheets": "sheet", "Calendar": "cal"}[service] + str(len(self.created) + 1)
            self.created.append(service)
            {"Tasks": self.lists, "Sheets": self.sheets, "Calendar": self.calendars}[service].add(name)
            return {"id": name, "spreadsheetId": name}
        calendar = url.split("calendars/")[1].split("/")[0]
        if calendar not in self.calendars:
            raise GoogleError(404, "Calendar")
        return {"items": []}

    def sheet_cell(self, cell):
        if self.config["spreadsheet"] not in self.sheets:
            raise GoogleError(404, "Sheets")
        return self.header.get(self.config["spreadsheet"], [])

    def sheet_row(self, row, values):
        self.header[self.config["spreadsheet"]] = [[values[0]]]

    def protect_source(self):
        self.sheet_id = 7


class Provision(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_first_connect_creates_everything_and_a_retry_reuses_it(self):
        config = {"inbox": "@default"}
        api = FakeGoogle(config)
        self.assertEqual(provision(self.directory, api, config, True), {"tasks", "sheet", "calendar"})
        self.assertEqual((config["ready"], config["source_sheet_id"], api.header[config["spreadsheet"]]),
                         (True, 7, [[HEADERS[0]]]))
        self.assertEqual(provision(self.directory, api, config, True), set())
        self.assertEqual(len(api.created), 3)

    def test_without_recreate_a_deleted_resource_is_an_error(self):
        config = {"inbox": "@default"}
        api = FakeGoogle(config)
        provision(self.directory, api, config, True)
        api.lists.discard(config["task_list"])
        with self.assertRaises(GoogleError):
            provision(self.directory, api, config, True)

    def test_recreate_remakes_deleted_or_trashed_resources_only(self):
        config = {"inbox": "@default"}
        api = FakeGoogle(config)
        provision(self.directory, api, config, False)  # no calendar at first
        old_list, old_sheet = config["task_list"], config["spreadsheet"]
        self.assertEqual(provision(self.directory, api, config, True, recreate=True), {"calendar"})
        self.assertEqual((config["task_list"], config["spreadsheet"]), (old_list, old_sheet))
        api.trashed.add(old_sheet)  # moved to the Drive trash counts as deleted
        api.lists.discard(old_list)
        self.assertEqual(provision(self.directory, api, config, True, recreate=True), {"tasks", "sheet"})
        self.assertNotIn(config["task_list"], (old_list,))
        self.assertNotEqual(config["spreadsheet"], old_sheet)
        self.assertEqual(api.header[config["spreadsheet"]], [[HEADERS[0]]])
        api.calendars.discard(config["calendar_outbox"])
        self.assertEqual(provision(self.directory, api, config, True, recreate=True), {"calendar"})
        # Other failures (not "gone") still stop the reconnect.
        api.tasks = lambda *a, **k: (_ for _ in ()).throw(GoogleError(403, "Tasks"))
        with self.assertRaises(GoogleError):
            provision(self.directory, api, config, True, recreate=True)


if __name__ == "__main__":
    unittest.main()
