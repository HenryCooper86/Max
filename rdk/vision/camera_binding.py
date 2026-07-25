"""Explicit MIPI port selection for RDK X5 cameras.

The stock ``libsrcampy.open_cam(port, -1, ...)`` auto-detect is unusable on this
board: it always searches ``vcon@0`` (i2c bus 6), which has no connector, reports
a phantom ov5647 there, and ``cam-service`` NULL-dereferences initialising a
sensor that does not exist — taking the whole pipeline down.

So we bypass it and call ``hbn_camera_create`` ourselves with ``bus_select`` set
to the VCON index, mirroring what the vendor's own ``mipi_cam`` node does.
Struct layout is copied from /usr/include/hb_camera_data_config.h.
"""

from __future__ import annotations

import ctypes
from dataclasses import dataclass

CAMERA_MODULE_NAME_LEN = 108
LIBCAM_PATH = "/usr/hobot/lib/libcam.so"

#: VCON indices that physically exist on this board.
VALID_VCON = (0, 1, 2, 3)


class CameraError(RuntimeError):
    """Raised when the vendor stack refuses to create or attach a camera."""


@dataclass(frozen=True)
class SensorSpec:
    name: str
    addr: int


#: Measured on hardware: IMX219 streams, OV5647 fails at video-flow start.
IMX219 = SensorSpec(name="imx219", addr=0x10)
OV5647 = SensorSpec(name="ov5647", addr=0x36)


class CameraConfig(ctypes.Structure):
    """Mirrors ``camera_config_t``. Field ORDER is load-bearing — ctypes lays the
    struct out positionally, so a reordered field corrupts everything after it."""

    _fields_ = [
        ("name", ctypes.c_char * CAMERA_MODULE_NAME_LEN),
        ("addr", ctypes.c_uint32),
        ("isp_addr", ctypes.c_uint32),
        ("eeprom_addr", ctypes.c_uint32),
        ("serial_addr", ctypes.c_uint32),
        ("sensor_mode", ctypes.c_uint32),
        ("sensor_clk", ctypes.c_uint32),
        ("gpio_enable_bit", ctypes.c_uint32),
        ("gpio_level_bit", ctypes.c_uint32),
        ("bus_select", ctypes.c_uint32),
        ("bus_timeout", ctypes.c_uint32),
        ("fps", ctypes.c_uint32),
        ("width", ctypes.c_uint32),
        ("height", ctypes.c_uint32),
        ("format", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
        ("extra_mode", ctypes.c_uint32),
        ("config_index", ctypes.c_uint32),
        ("ts_compensate", ctypes.c_int32),
        ("mipi_cfg", ctypes.c_void_p),
        ("calib_lname", ctypes.c_char * CAMERA_MODULE_NAME_LEN),
        ("sensor_param", ctypes.c_char_p),
        ("iparam_mode", ctypes.c_uint32),
        ("end_flag", ctypes.c_uint32),
    ]


def build_config(sensor: SensorSpec, vcon: int, width: int, height: int, fps: int) -> CameraConfig:
    """Build a config pinned to one VCON. ``mipi_cfg`` stays NULL so the vendor
    stack derives the MIPI timing itself — that part it gets right."""
    if vcon not in VALID_VCON:
        raise ValueError(f"vcon must be one of {VALID_VCON}, got {vcon}")

    cfg = CameraConfig()
    cfg.name = sensor.name.encode("ascii")[: CAMERA_MODULE_NAME_LEN - 1]
    cfg.addr = sensor.addr
    cfg.bus_select = vcon
    cfg.width = width
    cfg.height = height
    cfg.fps = fps
    cfg.mipi_cfg = None
    return cfg


def open_camera(config: CameraConfig) -> int:
    """Create a camera handle for the pinned port. Raises CameraError on failure
    rather than returning a sentinel, so a caller cannot use a dead handle."""
    lib = ctypes.CDLL(LIBCAM_PATH)
    lib.hbn_camera_create.argtypes = [ctypes.POINTER(CameraConfig), ctypes.POINTER(ctypes.c_uint64)]
    lib.hbn_camera_create.restype = ctypes.c_int32

    handle = ctypes.c_uint64(0)
    ret = lib.hbn_camera_create(ctypes.byref(config), ctypes.byref(handle))
    if ret != 0:
        raise CameraError(
            f"hbn_camera_create failed (ret={ret}) for {config.name.decode()} on vcon {config.bus_select}"
        )
    return handle.value
