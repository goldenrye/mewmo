"""Run in the backend virtual environment; output belongs only in Mewmo's .env."""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

private = ec.generate_private_key(ec.SECP256R1())
raw = private.private_numbers().private_value.to_bytes(32, "big")
public = private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode()
print("VAPID_PRIVATE_KEY=" + encode(raw))
print("VAPID_PUBLIC_KEY=" + encode(public))
