UPDATE users
SET
  display_name = 'SAH',
  password_hash = 'pbkdf2_sha256$260000$YxT8PD2223ge85CuRThlOg$Tm8RUiK40RX4OxPZpf93qgxynQQiQl4fkKAk8E8-mxM',
  password_reset_required = false,
  updated_at = now()
WHERE lower(email) = lower('pruefer@example.local');
