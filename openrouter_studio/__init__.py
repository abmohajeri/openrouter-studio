"""OpenRouter Studio: a local web studio, CLI and Python library for OpenRouter.

    from openrouter_studio import OpenRouterClient
    client = OpenRouterClient()
    print(client.ask("Hello!", model="gemini"))
"""

__version__ = "2.1.0"

from .client import (  # noqa: E402
    DEFAULT_MODEL,
    MODEL_ALIASES,
    OpenRouterClient,
    OpenRouterError,
    resolve_model,
)

__all__ = ["OpenRouterClient", "OpenRouterError", "MODEL_ALIASES", "DEFAULT_MODEL", "resolve_model", "__version__"]
