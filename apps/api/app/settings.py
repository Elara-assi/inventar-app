from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://inventar:inventar@localhost:5432/inventar"
    upload_root: str = "./storage/uploads"
    app_origin: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000,http://127.0.0.1:3002,https://inventar.elarahub.cloud"
    demo_user_email: str = "pruefer@example.local"
    auth_secret: str = "change-me-in-env"
    auth_token_minutes: int = 720
    db_pool_min_size: int = 1
    db_pool_max_size: int = 12
    db_pool_timeout_seconds: float = 5.0
    max_upload_bytes: int = 35 * 1024 * 1024
    allowed_upload_mime_types: str = "image/jpeg,image/png,image/webp,image/heic,image/heif"
    migrations_path: str = "/app/db/migrations"
    enable_migration_runner: bool = True
    default_tenant_slug: str = "default"
    default_tenant_name: str = "Standardmandant"
    ollama_url: str = "http://localhost:11434"
    ollama_local_url: str = "http://localhost:11434"
    ollama_api_key: str = ""
    ollama_model: str = "qwen3-vl:235b-cloud"
    ollama_vision_model: str = "qwen3-vl:235b-cloud"
    ollama_ocr_model: str = "glm-ocr:latest"
    ollama_fallback_model: str = "gemma4:31b-cloud"
    ollama_timeout_seconds: float = 120.0
    search_provider: str = "searxng"
    searxng_base_url: str = "http://searxng-fe55-searxng-1:8080"
    search_timeout_seconds: float = 10.0
    brave_search_api_key: str = ""
    serpapi_api_key: str = ""

    def cors_origin_list(self) -> list[str]:
        values = [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]
        if self.app_origin and self.app_origin not in values:
            values.append(self.app_origin)
        return values

    def allowed_upload_mime_list(self) -> set[str]:
        return {value.strip().lower() for value in self.allowed_upload_mime_types.split(",") if value.strip()}

    def uses_default_auth_secret(self) -> bool:
        return not self.auth_secret or self.auth_secret.startswith("change-me")


settings = Settings()
