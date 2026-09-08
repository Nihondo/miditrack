"""miditrackローカルWebアプリの互換公開ファサード。"""

from .web_routes import *  # noqa: F403
from .web_routes import _track_filename_label


if __name__ == "__main__":  # pragma: no cover
    run_server()  # noqa: F405
