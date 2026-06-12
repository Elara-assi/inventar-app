from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://inventar:inventar@localhost:5432/inventar"
    upload_root: str = "./storage/uploads"
    app_origin: str = "http://localhost:3000"
    demo_user_email: str = "pruefer@example.local"
    db_pool_min: int = 1
    db_pool_max: int = 10
    max_upload_mb: int = 15


settings = Settings()
