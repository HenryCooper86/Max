import ctypes
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from camera_binding import IMX219, OV5647, CameraConfig, build_config


def test_struct_field_order_matches_the_vendor_header():
    # Order is load-bearing: ctypes lays the struct out positionally, so a
    # reordered field silently corrupts every value after it.
    names = [f[0] for f in CameraConfig._fields_]
    assert names[:6] == ["name", "addr", "isp_addr", "eeprom_addr", "serial_addr", "sensor_mode"]
    assert "bus_select" in names
    assert "gpio_enable_bit" in names
    assert names[-1] == "end_flag"


def test_bus_select_precedes_fps_and_geometry():
    names = [f[0] for f in CameraConfig._fields_]
    assert names.index("bus_select") < names.index("fps") < names.index("width") < names.index("height")


def test_build_config_pins_the_port():
    cfg = build_config(IMX219, vcon=2, width=1920, height=1080, fps=30)
    assert cfg.bus_select == 2
    assert cfg.addr == 0x10
    assert cfg.name == b"imx219"
    assert cfg.width == 1920
    assert cfg.height == 1080
    assert cfg.fps == 30


def test_build_config_leaves_mipi_cfg_null_for_auto():
    cfg = build_config(IMX219, vcon=2, width=1920, height=1080, fps=30)
    assert not cfg.mipi_cfg  # NULL => vendor stack derives MIPI config itself


def test_sensor_specs_match_measured_hardware():
    assert (IMX219.name, IMX219.addr) == ("imx219", 0x10)
    assert (OV5647.name, OV5647.addr) == ("ov5647", 0x36)


def test_rejects_a_vcon_outside_the_board_range():
    with pytest.raises(ValueError):
        build_config(IMX219, vcon=9, width=1920, height=1080, fps=30)


def test_name_is_truncated_not_overflowed():
    long_sensor = type(IMX219)(name="x" * 200, addr=0x10)
    cfg = build_config(long_sensor, vcon=2, width=1920, height=1080, fps=30)
    assert len(cfg.name) < 200


def test_ctypes_is_imported_for_struct_definition():
    assert issubclass(CameraConfig, ctypes.Structure)
