import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from sensors import (
    BUS_CHANNEL,
    CAMERA_BUSES,
    UnsupportedSensor,
    describe_scan,
    discover,
    identify,
    preflight,
)


def fake_scan(mapping):
    """Stand-in for i2cdetect: bus number -> list of responding addresses."""

    def scan(bus: int) -> list[int]:
        return mapping.get(bus, [])

    return scan


def test_camera_buses_are_the_two_connector_buses():
    assert CAMERA_BUSES == (4, 6)


def test_identify_names_the_known_sensors():
    assert identify(0x10).name == "imx219"
    assert identify(0x36).name == "ov5647"


def test_identify_returns_none_for_an_unknown_address():
    assert identify(0x42) is None


def test_bus_channel_maps_each_connector_to_its_one_host():
    # The board reports "support mipi: host 0, host 2" — hosts 1 and 3 do not
    # exist, so a connector carries one camera, not two.
    assert BUS_CHANNEL == {6: 0, 4: 2}


def test_discover_names_the_sensor_on_each_channel():
    found = discover(fake_scan({6: [0x36], 4: [0x10]}))
    assert found == {0: "OV5647", 2: "IMX219"}


def test_discover_reports_only_populated_channels():
    assert discover(fake_scan({6: [0x36]})) == {0: "OV5647"}


def test_discover_ignores_unknown_addresses():
    assert discover(fake_scan({6: [0x0C, 0x36]})) == {0: "OV5647"}


def test_discover_is_empty_when_nothing_is_attached():
    assert discover(fake_scan({})) == {}


def test_preflight_passes_with_an_ov5647():
    # The regression that motivated this change: the old preflight vetoed 0x36
    # and would have rejected the camera now streaming in CAM1.
    preflight(fake_scan({6: [0x36]}))


def test_preflight_still_fails_on_an_empty_bus():
    with pytest.raises(UnsupportedSensor) as error:
        preflight(fake_scan({}))
    assert "not seated" in str(error.value)


def test_preflight_passes_with_an_imx219():
    preflight(fake_scan({4: [0x10]}))


def test_preflight_passes_with_two_imx219():
    preflight(fake_scan({4: [0x10], 6: [0x10]}))


def test_preflight_rejects_when_no_sensor_answers():
    with pytest.raises(UnsupportedSensor) as excinfo:
        preflight(fake_scan({}))
    assert "no camera" in str(excinfo.value).lower()


def test_preflight_accepts_a_mixed_pair_because_one_camera_is_enough():
    # Front-only is a first-class corpus entry, so an unusable second module
    # must not block the ride.
    preflight(fake_scan({4: [0x10], 6: [0x36]}))


def test_describe_scan_reports_bus_and_sensor():
    text = describe_scan(fake_scan({4: [0x10], 6: [0x36]}))
    assert "bus 4" in text and "imx219" in text
    assert "bus 6" in text and "ov5647" in text


def test_describe_scan_marks_an_empty_bus():
    assert "empty" in describe_scan(fake_scan({4: [0x10]})).lower()
