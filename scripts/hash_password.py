"""Run with Python 3.12+; prints a hash, never the password."""
import getpass
import hashlib
import secrets

password = getpass.getpass("Mewmo owner password (at least 12 characters): ")
if len(password) < 12:
    raise SystemExit("Use at least 12 characters.")
if password != getpass.getpass("Repeat password: "):
    raise SystemExit("Passwords do not match.")
salt = secrets.token_hex(16)
digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
print(f"OWNER_PASSWORD_HASH='scrypt${salt}${digest}'")
