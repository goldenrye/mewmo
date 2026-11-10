import io
import math
import runpy
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "frontend/ios/App/App"


def test_alarm_audio_is_reproducible_pcm_without_clipping():
    generator = runpy.run_path(str(ROOT / "scripts/generate_alarm_sound.py"))
    data = (APP / generator["FILENAME"]).read_bytes()
    assert data == generator["render_alarm"]()
    with wave.open(io.BytesIO(data), "rb") as audio:
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getframerate() == 44100
        assert audio.getcomptype() == "NONE"
        assert audio.getnframes() / audio.getframerate() == 8
        frames = audio.readframes(audio.getnframes())
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    assert 25000 < max(abs(sample) for sample in samples) < 32767
    assert math.sqrt(sum(sample * sample for sample in samples) / len(samples)) > 3000
    assert abs(samples[0]) < 10 and abs(samples[-1]) < 10


def test_named_sound_is_in_the_native_resource_build_phase():
    source = (APP / "UrgentAlarmPlugin.swift").read_text()
    project = (APP.parent / "App.xcodeproj/project.pbxproj").read_text()
    assert 'private let soundName = "traditional-alarm.wav"' in source
    assert "sound: .named(soundName)" in source
    resources = project.split("/* Begin PBXResourcesBuildPhase section */")[1].split(
        "/* End PBXResourcesBuildPhase section */"
    )[0]
    assert "traditional-alarm.wav in Resources" in resources
    assert 'path = "traditional-alarm.wav"' in project


@pytest.mark.skipif(shutil.which("swift") is None, reason="Swift toolchain not installed")
def test_sound_upgrade_preserves_legacy_records_and_dismissed_or_ringing_alarms():
    source = (APP / "UrgentAlarmPlugin.swift").read_text()
    record = source.split("private struct AlarmRecord: Codable {")[1].split(
        "private struct AlarmRegistry"
    )[0]
    swift = "import Foundation\nstruct AlarmRecord: Codable {" + record + """
let old = try JSONDecoder().decode(
    AlarmRecord.self, from: Data(#"{"fingerprint":"saved","fireAt":200}"#.utf8))
assert(old.soundName == nil)
let sound = "traditional-alarm.wav"
assert(!old.keepUnchanged(exists: true, alerting: false, now: 100, sound: sound, force: false))
assert(old.keepUnchanged(exists: true, alerting: true, now: 100, sound: sound, force: false))
assert(old.keepUnchanged(exists: true, alerting: false, now: 200, sound: sound, force: false))
assert(old.keepUnchanged(exists: false, alerting: false, now: 100, sound: sound, force: false))
assert(!old.keepUnchanged(exists: false, alerting: false, now: 100, sound: sound, force: true))
let updated = AlarmRecord(fingerprint: "saved", fireAt: 200, soundName: sound)
assert(updated.keepUnchanged(exists: true, alerting: false, now: 100, sound: sound, force: false))
let restored = try JSONDecoder().decode(AlarmRecord.self, from: JSONEncoder().encode(updated))
assert(restored.soundName == sound)
"""
    result = subprocess.run(["swift", "-"], input=swift, text=True, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr
