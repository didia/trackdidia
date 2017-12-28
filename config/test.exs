use Mix.Config

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :trackdidia, Trackdidia.Endpoint,
  http: [port: 4001],
  server: false

# Print only warnings and errors during test
config :logger, level: :warn

# Configure the database
config :trackdidia, Trackdidia.Repo,
  adapter: Ecto.Adapters.Postgres,
  url: System.get_env("DATABASE_URL"),
  pool: Ecto.Adapters.SQL.Sandbox
