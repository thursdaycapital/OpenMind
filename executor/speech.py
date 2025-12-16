import os
import subprocess


def speak(text: str) -> None:
    """
    Best-effort TTS for local debugging.

    - macOS: uses `say`
    - otherwise: prints to stdout

    Control with env:
      EXECUTOR_TTS = "mac_say" | "print" | "none"
    """

    mode = os.getenv("EXECUTOR_TTS", "print").strip().lower()
    if mode in ("none", "off", "disabled"):
        return

    if mode in ("mac_say", "say") and os.uname().sysname.lower() == "darwin":
        # Non-blocking speech (ok for demo); if you want blocking, remove Popen.
        subprocess.Popen(["say", text])
        return

    print(f"[executor:speak] {text}")


