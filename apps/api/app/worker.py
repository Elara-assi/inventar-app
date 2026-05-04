import time

from .settings import settings


def main() -> None:
    print("Inventar worker started")
    print(f"Upload root: {settings.upload_root}")
    print("Phase 1 worker is a placeholder for LiteLLM, stamping, export queues and duplicate checks.")
    while True:
        time.sleep(30)


if __name__ == "__main__":
    main()
