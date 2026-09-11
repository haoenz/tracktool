"""Shared test constants and fixtures."""

TRACK_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>2024-05-01 test</name>
<Folder>
<Placemark>
<name>track</name>
<gx:Track>
<when>2024-05-01T00:00:00Z</when>
<when>2024-05-01T00:01:00Z</when>
<when>2024-05-01T00:02:00Z</when>
<when>2024-05-01T00:03:00Z</when>
<gx:coord>116.0 39.0 100</gx:coord>
<gx:coord>116.1 39.1 110</gx:coord>
<gx:coord>116.2 39.2 120</gx:coord>
<gx:coord>116.3 39.3 130</gx:coord>
</gx:Track>
</Placemark>
</Folder>
</Document>
</kml>"""
