INSERT INTO brand_lexicon (name, category) VALUES
  ('Nussbaum', 'werkstatt'), ('MAHA', 'werkstatt'), ('Hofmann', 'werkstatt'),
  ('Consul', 'werkstatt'), ('Stertil-Koni', 'werkstatt'), ('Zippo', 'werkstatt'),
  ('Bosch', 'werkstatt'), ('Hazet', 'werkzeug'), ('Gedore', 'werkzeug'),
  ('Wuerth', 'werkzeug'), ('Stahlwille', 'werkzeug'), ('Snap-on', 'werkzeug'),
  ('Festool', 'werkzeug'), ('Makita', 'werkzeug'), ('Hilti', 'werkzeug'),
  ('Dell', 'it'), ('HP', 'it'), ('Lenovo', 'it'), ('Apple', 'it'),
  ('Samsung', 'it'), ('LG', 'it'), ('Fujitsu', 'it'), ('Asus', 'it'),
  ('Acer', 'it'), ('Brother', 'it'), ('Canon', 'it'), ('Epson', 'it'),
  ('Michelin', 'reifen'), ('Continental', 'reifen'), ('Bridgestone', 'reifen'),
  ('Pirelli', 'reifen'), ('Goodyear', 'reifen'), ('Dunlop', 'reifen'),
  ('Hankook', 'reifen'), ('Vredestein', 'reifen'), ('Falken', 'reifen')
ON CONFLICT (name) DO NOTHING;
