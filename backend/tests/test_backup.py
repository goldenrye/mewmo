import os
import subprocess
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/backup.sh"


def run_backup(tmp_path, fail=False):
    tools = tmp_path / "tools"
    tools.mkdir()
    dump = tools / "pg_dump"
    dump.write_text(
        "#!/bin/sh\nexit 1\n"
        if fail
        else '#!/bin/sh\nfor arg in "$@"; do case "$arg" in --file=*) printf test-dump > "${arg#--file=}";; esac; done\n'
    )
    restore = tools / "pg_restore"
    restore.write_text('#!/bin/sh\ntest "$(cat "$2")" = "test-dump"\n')
    dump.chmod(0o700)
    restore.chmod(0o700)
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir(exist_ok=True)
    env = os.environ | {
        "PATH": f"{tools}:{os.environ['PATH']}",
        "BACKUP_DIR": str(backup_dir),
        "BACKUP_ONCE": "1",
        "BACKUP_RETENTION_DAYS": "1",
    }
    return subprocess.run(["sh", str(SCRIPT)], env=env, capture_output=True, timeout=10), backup_dir


def test_atomic_backup_no_intermediate_files(tmp_path):
    result, directory = run_backup(tmp_path)
    assert result.returncode == 0
    dumps = list(directory.glob("mewmo-*.dump"))
    assert len(dumps) == 1
    assert dumps[0].read_text() == "test-dump"
    assert not list(directory.glob(".mewmo-*"))
    assert dumps[0].stat().st_mode & 0o077 == 0


def test_failed_backup_keeps_old_dumps(tmp_path):
    directory = tmp_path / "backups"
    directory.mkdir()
    previous = directory / "mewmo-previous.dump"
    previous.write_text("old-good-backup")
    old = time.time() - 10 * 86400
    os.utime(previous, (old, old))
    result, _ = run_backup(tmp_path, fail=True)
    assert result.returncode == 1
    assert previous.exists()
    assert not list(directory.glob(".mewmo-*"))
