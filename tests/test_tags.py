"""The tag vocabulary: one spelling per name, and read groups that cover what
the rules look for.

Both failures these guard against are silent in production: two names for one
tag diverge on the next edit, and a parse candidate that is not in the read
group is simply never read — the rule then falls through to its next candidate
and reports "no timestamp" for a file that has one.
"""

from tracktool import mediatime, tags


def _named_constants() -> dict[str, str]:
    """Every module-level name holding a single tag spelling."""
    return {name: value for name, value in vars(tags).items() if name.isupper() and isinstance(value, str)}


class TestSpellings:
    def test_no_two_names_share_a_spelling(self):
        seen: dict[str, str] = {}
        for name, value in sorted(_named_constants().items()):
            assert value not in seen, f"{name} and {seen[value]} both spell {value!r}"
            seen[value] = name


class TestReadGroups:
    def test_the_time_group_covers_every_parse_candidate(self):
        candidates = {cfg.tag for cfg in mediatime._TAG_CONFIGS}
        candidates |= {tag for cfg in mediatime._TAG_CONFIGS for tag in cfg.offset_tags}
        assert candidates <= set(tags.TIME_TAGS)

    def test_the_time_group_names_each_tag_once(self):
        assert len(set(tags.TIME_TAGS)) == len(tags.TIME_TAGS)

    def test_position_group_adds_the_gps_tags_to_the_time_group(self):
        assert set(tags.POSITION_TAGS) == {*tags.TIME_TAGS, tags.LATITUDE, tags.LONGITUDE, tags.ALTITUDE}


class TestTimestampTagSets:
    def test_every_make_constant_is_a_key(self):
        assert {make for make, _ in tags.TIMESTAMP_TAG_SETS} == {tags.MAKE_SONY, tags.MAKE_FUJIFILM, tags.MAKE_INSTA360}

    def test_each_set_is_a_distinct_group_of_known_tags(self):
        known = set(_named_constants().values())
        for key, tag_set in tags.TIMESTAMP_TAG_SETS.items():
            assert tag_set, key
            assert len(set(tag_set)) == len(tag_set), key
            assert set(tag_set) <= known, key
