"""The promises a MetadataBackend makes, asserted once for both of them.

The app runs on `ExiftoolBackend` and the rules are tested against
`InMemoryBackend`; were the two to answer differently, a rule could pass the
suite and still fail on a real file. Subclass this once per backend and provide
two fixtures — `backend`, and `photo`, a file the backend may write to. The
in-memory subclass is collected on every run; the exiftool one carries
`integration`, so it runs wherever the tool is installed.

The vocabulary is deliberately tiny: one text tag to write, one timestamp to
shift. What is under test is the shape of the seam, not exiftool's tag support.
"""

from datetime import timedelta

CITY = "IPTC:City"
STAMP = "ExifIFD:DateTimeOriginal"


class BackendContract:
    """Assertions shared by every backend; pytest injects `backend` and `photo`."""

    def test_a_tag_the_file_lacks_is_absent_rather_than_empty(self, backend, photo):
        assert backend.read_tags(photo, [CITY, "GPSAltitude"]) == {}

    def test_the_result_is_keyed_by_the_names_that_were_requested(self, backend, photo):
        backend.write_tags(photo, {CITY: "Beijing"}, overwrite=True)

        assert backend.read_tags(photo, [CITY]) == {CITY: "Beijing"}

    def test_a_second_write_replaces_the_first(self, backend, photo):
        backend.write_tags(photo, {CITY: "Beijing"}, overwrite=True)
        backend.write_tags(photo, {CITY: "Shanghai"}, overwrite=True)

        assert backend.read_tags(photo, [CITY]) == {CITY: "Shanghai"}

    def test_a_shift_moves_the_stamp_it_names(self, backend, photo):
        backend.write_tags(photo, {STAMP: "2024:05:01 08:00:00"}, overwrite=True)

        backend.shift_tags(photo, [STAMP], timedelta(hours=1, minutes=30), overwrite=True)

        assert backend.read_tags(photo, [STAMP]) == {STAMP: "2024:05:01 09:30:00"}

    def test_a_shift_backwards_crosses_into_the_previous_day(self, backend, photo):
        backend.write_tags(photo, {STAMP: "2024:05:01 00:30:00"}, overwrite=True)

        backend.shift_tags(photo, [STAMP], timedelta(hours=-2), overwrite=True)

        assert backend.read_tags(photo, [STAMP]) == {STAMP: "2024:04:30 22:30:00"}

    def test_a_shift_leaves_the_tags_it_does_not_name(self, backend, photo):
        backend.write_tags(photo, {CITY: "Shanghai", STAMP: "2024:05:01 08:00:00"},
                           overwrite=True)

        backend.shift_tags(photo, [STAMP], timedelta(minutes=10), overwrite=True)

        assert backend.read_tags(photo, [CITY]) == {CITY: "Shanghai"}
