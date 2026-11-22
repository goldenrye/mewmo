import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("swift") is None, reason="Swift toolchain not installed")
def test_biometric_preference_survives_renewal_but_never_crosses_accounts():
    source = (
        Path(__file__).resolve().parents[2] / "frontend/ios/App/App/BiometricSessionPlugin.swift"
    ).read_text()
    policy = source[source.index("private enum BiometricPreferencePolicy") : source.index("@objc(")]
    swift = (
        policy
        + """
for enabled in [false, true] {
    for preserve in [false, true] {
        for owner: String? in [nil, "alice", "bob"] {
            for userId: String? in [nil, "alice", "bob"] {
                let expected = enabled && preserve &&
                    (userId == nil || (owner != nil && owner == userId))
                assert(BiometricPreferencePolicy.keepEnabled(
                    enabled: enabled, preserve: preserve, owner: owner, userId: userId
                ) == expected)
            }
        }
    }
}
"""
    )
    result = subprocess.run(["swift", "-"], input=swift, text=True, capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr
