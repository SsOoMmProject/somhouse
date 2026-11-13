"""Verify Sheets requests against SQLite without sending family data to Google."""

from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from server import Store, encode
from sheets_sync import SheetsSync


class SheetsExport(unittest.TestCase):
    def test_failure_retry_edit_and_delete_use_one_current_snapshot(self):
        with TemporaryDirectory() as directory:
            store = Store(directory)
            session = Mock()
            session.get.return_value.json.return_value = {
                "sheets": [{"properties": {
                    "sheetId": 8, "gridProperties": {"rowCount": 2, "columnCount": 6},
                }}],
            }
            sync = SheetsSync(store, "test", 8, session)
            feeding = {
                "id": "test", "type": "feeding", "date": "2026-11-13T12:34",
                "category": "분유", "amount": "80ml", "memo": "=1+1",
            }
            with store.connect() as db:
                db.execute("INSERT INTO items VALUES(?, ?, ?)", ("records", "test", encode(feeding)))
                db.execute("INSERT INTO items VALUES(?, ?, ?)",
                           ("records", "private", encode({"type": "hospital", "memo": "private"})))

            session.post.side_effect = OSError("connection dropped")
            with self.assertRaises(OSError):
                sync.sync()
            first = session.post.call_args.kwargs["json"]
            session.post.side_effect = None
            self.assertTrue(sync.sync())
            self.assertEqual(session.post.call_args.kwargs["json"], first)
            self.assertFalse(sync.sync())
            self.assertEqual(session.post.call_count, 2)
            self.assertEqual(first["requests"][0]["appendDimension"]["dimension"], "COLUMNS")
            cells = first["requests"][-1]["updateCells"]
            self.assertEqual(len(cells["rows"]), 2)
            values = cells["rows"][1]["values"]
            self.assertEqual(values[5]["userEnteredValue"], {"numberValue": 80})
            self.assertEqual(values[6]["userEnteredValue"], {"stringValue": "=1+1"})

            with store.connect() as db:
                feeding["amount"] = "15분"
                db.execute("UPDATE items SET body=? WHERE id=?", (encode(feeding), "test"))
            self.assertTrue(sync.sync())
            edited = session.post.call_args.kwargs["json"]["requests"][-1]["updateCells"]
            self.assertEqual(edited["rows"][1]["values"][5], {})
            with store.connect() as db:
                db.execute("DELETE FROM items WHERE id=?", ("test",))
            self.assertTrue(sync.sync())
            deleted = session.post.call_args.kwargs["json"]["requests"][-1]["updateCells"]
            self.assertEqual(len(deleted["rows"]), 1)
            self.assertEqual(deleted["range"]["endRowIndex"], 2)
