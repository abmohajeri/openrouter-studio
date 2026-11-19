#!/usr/bin/env python3
"""Command-line tool from the project folder: python main.py -h

Same as the installed `openrouter` command. The code is in openrouter_studio/cli.py.
"""

import sys

from openrouter_studio.cli import main

if __name__ == "__main__":
    sys.exit(main())
