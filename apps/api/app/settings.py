from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://inventar:inventar@localhost:5432/inventar"
    upload_root: str = "./storage/uploads"
    app_origin: str = "http://localhost:3000"
    demo_user_email: str = "pruefer@example.local"


settings = Settings()
