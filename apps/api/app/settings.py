from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://inventar:inventar@localhost:5432/inventar"
    upload_root: str = "./storage/uploads"
    app_origin: str = "http://localhost:3000"
    demo_user_email: str = "pruefer@example.local"
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "gemma3:27b-it-qat"
    ollama_timeout_seconds: float = 45.0


settings = Settings()
