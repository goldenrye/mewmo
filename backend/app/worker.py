import logging
import signal
import threading
import time

from sqlalchemy.orm import sessionmaker

from .database import engine
from .push import send_push
from .reminders import scan


def main():
    logging.basicConfig(level=logging.INFO)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    factory = sessionmaker(engine(), expire_on_commit=False)
    while not stopped.is_set():
        started = time.monotonic()
        try:
            scan(factory, send_push)
        except Exception:
            logging.error("Reminder scan failed; retrying on next scan")
        stopped.wait(max(0, 60 - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
