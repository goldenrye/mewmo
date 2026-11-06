from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = "postgresql+psycopg://mewmo:mewmo@db/mewmo"
    owner_password_hash: str = ""
    admin_username: str = "admin"
    admin_password_hash: str = ""
    public_web_url: str = ""
    cors_origins: str = "http://localhost:5173,capacitor://localhost"
    cookie_secure: bool = True
    apns_key_path: str = ""
    apns_key_id: str = ""
    apns_team_id: str = ""
    apns_topic: str = "com.jpi.mewmo"
    apns_sandbox: bool = False
    vapid_private_key: str = ""
    vapid_public_key: str = ""
    vapid_subject: str = "mailto:owner@example.com"

    @property
    def origins(self) -> list[str]:
        return [value.strip() for value in self.cors_origins.split(",") if value.strip()]


@lru_cache
def settings() -> Settings:
    return Settings()
