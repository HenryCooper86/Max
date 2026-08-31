"""vision.watch: a periodic, change-gated frame sampler.

Separate from the ADAS shadow pipeline and from bench_server's preview: this
package exists to let the agent ask "has the scene changed" at a slow,
governed cadence, for a rider who wants Max to notice without paying for a
frame every 30 seconds regardless of whether anything moved.
"""

from __future__ import annotations
