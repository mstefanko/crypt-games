"""Local TCP relay with a small real receive window for slow-consumer tests.

The upstream socket stops reading on 'pause'; no application data is fabricated.
A small SO_RCVBUF prevents host-specific multi-megabyte automatic receive buffers
from turning a bounded backpressure test into a multi-minute wait.
"""
import json
import socket
import sys
import threading

port = int(sys.argv[1])
reading = threading.Event()
reading.set()
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen()
print(json.dumps({"port": server.getsockname()[1]}), flush=True)


def relay(source, destination, gated=False):
    try:
        while True:
            if gated:
                reading.wait()
            data = source.recv(4096)
            if not data:
                break
            destination.sendall(data)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def accept():
    while True:
        browser, _ = server.accept()
        upstream = socket.socket()
        upstream.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        upstream.connect(("127.0.0.1", port))
        threading.Thread(target=relay, args=(browser, upstream), daemon=True).start()
        threading.Thread(target=relay, args=(upstream, browser, True), daemon=True).start()


threading.Thread(target=accept, daemon=True).start()
for command in sys.stdin:
    if command.strip() == "pause":
        reading.clear()
    elif command.strip() == "resume":
        reading.set()
