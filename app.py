#!/usr/bin/env python3
"""Start the web studio from the project folder: python app.py [--port 9000] [--no-browser]

Same as the installed `openrouter-studio` command. The code is in openrouter_studio/server.py.
"""

from openrouter_studio.server import main

if __name__ == "__main__":
    main()
