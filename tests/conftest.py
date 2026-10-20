"""Puts server/ on the import path so tests can `import main`, `import pdf_engine` and so on."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))
