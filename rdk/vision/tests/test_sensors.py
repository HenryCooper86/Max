import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from sensors import (
    CAMERA_BUSES,
    SUPPORTED_ADDRS,
    UnsupportedSensor,
    describe_scan,
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


def test_only_imx219_is_supported():
    assert SUPPORTED_ADDRS == (0x10,)


def test_preflight_passes_with_an_imx219():
    preflight(fake_scan({4: [0x10]}))


def test_preflight_passes_with_two_imx219():
    preflight(fake_scan({4: [0x10], 6: [0x10]}))


def test_preflight_rejects_ov5647_by_name_and_points_somewhere_useful():
    with pytest.raises(UnsupportedSensor) as excinfo:
        preflight(fake_scan({4: [0x36]}))
    message = str(excinfo.value)
    assert "ov5647" in message.lower()
    assert "imx219" in message.lower()
    assert "README" in message


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
