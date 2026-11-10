"""Generate Mewmo's original twin-bell alarm sound using only the standard library."""

import io
import math
import random
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 44100
DURATION = 8
FILENAME = "traditional-alarm.wav"


def render_alarm() -> bytes:
    samples = [0.0] * (SAMPLE_RATE * DURATION)
    noise = random.Random(0)
    # Alternating metal bells struck rapidly, with a short pause between ringing bursts.
    for strike in range(DURATION * 12):
        onset = strike / 12
        if onset % 2 >= 1.5:
            continue
        start = round(onset * SAMPLE_RATE)
        frequency = 960 if strike % 2 == 0 else 1140
        for offset in range(min(round(0.4 * SAMPLE_RATE), len(samples) - start)):
            t = offset / SAMPLE_RATE
            attack = min(t / 0.002, 1)
            bell = sum(
                amplitude * math.exp(-t / decay) * math.sin(math.tau * frequency * ratio * t)
                for ratio, amplitude, decay in (
                    (1, 1, 0.095),
                    (2.01, 0.55, 0.07),
                    (2.73, 0.3, 0.045),
                    (3.97, 0.15, 0.025),
                )
            )
            hammer = noise.uniform(-1, 1) * 0.12 * math.exp(-t / 0.004)
            samples[start + offset] += attack * (bell + hammer)
    peak = max(abs(sample) for sample in samples)
    pcm = b"".join(struct.pack("<h", round(sample / peak * 0.8 * 32767)) for sample in samples)
    output = io.BytesIO()
    with wave.open(output, "wb") as sound:
        sound.setnchannels(1)
        sound.setsampwidth(2)
        sound.setframerate(SAMPLE_RATE)
        sound.writeframes(pcm)
    return output.getvalue()


if __name__ == "__main__":
    target = Path(__file__).resolve().parents[1] / "frontend/ios/App/App" / FILENAME
    target.write_bytes(render_alarm())
    print(f"Generated {target} ({DURATION}s, mono 16-bit PCM, {SAMPLE_RATE} Hz)")
