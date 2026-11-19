"""Backwards-compatible name for the library: `from openrouter_client import OpenRouterClient`.

The code lives in openrouter_studio/client.py. This module *is* that module (not a copy),
so changing e.g. openrouter_client.MODEL_ALIASES or DEFAULT_MODEL works as before.
"""

import sys

from openrouter_studio import client as _client

sys.modules[__name__] = _client
