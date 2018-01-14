use Mix.Config

defmodule Utilities do
  def string_to_boolean("true"), do: true
  def string_to_boolean("1"), do: true
  def string_to_boolean(_), do: false
end

{force_ssl, endpoint_url} =
  if Utilities.string_to_boolean(System.get_env("FORCE_SSL")) do
    {true, [schema: "https", port: 443, host: System.get_env("CANONICAL_HOST")]}
  else
    {false, [schema: "http", port: 80, host: System.get_env("CANONICAL_HOST")]}
  end

# General application configuration
config :trackdidia, ecto_repos: [Trackdidia.Repo]

# Configures the endpoint
config :trackdidia, TrackdidiaWeb.Endpoint,
  http: [port: System.get_env("PORT")],
  url: endpoint_url,
  secret_key_base: System.get_env("SECRET_KEY_BASE"),
  render_errors: [view: TrackdidiaWeb.Errors.View, accepts: ~w(html json)],
  pubsub: [name: Trackdidia.PubSub, adapter: Phoenix.PubSub.PG2]

# Configures internationalization
config :trackdidia, TrackdidiaWeb.Gettext,
  default_locale: "fr"

config :timex,
  default_locale: "fr"

# Configures Elixir's Logger
config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Configure your database
config :trackdidia, Trackdidia.Repo,
  adapter: Ecto.Adapters.Postgres,
  url: System.get_env("DATABASE_URL"),
  size: System.get_env("DATABASE_POOL_SIZE")

# Configure SSL
config :trackdidia,
  force_ssl: force_ssl,
  canonical_host: System.get_env("CANONICAL_HOST")

# Configure Basic Auth
if System.get_env("BASIC_AUTH_USERNAME") && String.trim(System.get_env("BASIC_AUTH_USERNAME")) != "" do
  config :trackdidia,
    basic_auth: [
      username: System.get_env("BASIC_AUTH_USERNAME"),
      password: System.get_env("BASIC_AUTH_PASSWORD")
    ]
end

config :sentry,
  dsn: System.get_env("SENTRY_DSN"),
  included_environments: [:prod],
  environment_name: Mix.env(),
  use_error_logger: true,
  root_source_code_path: File.cwd!(),
  enable_source_code_context: true

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{Mix.env()}.exs"
