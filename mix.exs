defmodule Trackdidia.Mixfile do
  use Mix.Project

  def project do
    [
      app: :trackdidia,
      version: "0.0.1",
      elixir: "~> 1.4",
      elixirc_paths: elixirc_paths(Mix.env()),
      test_paths: ["lib"],
      test_pattern: "**/*_test.exs",
      compilers: [:phoenix, :gettext] ++ Mix.compilers(),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps()
    ]
  end

  def application do
    [
      mod: {Trackdidia.Application, []},
      extra_applications: [:logger, :runtime_tools, :gettext, :timex]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      # Phoenix
      {:phoenix, "~> 1.3.0"},
      {:phoenix_html, "~> 2.10"},
      {:phoenix_ecto, "~> 3.2"},
      {:phoenix_live_reload, "~> 1.0", only: :dev},

      # Database
      {:postgrex, ">= 0.0.0"},

      # Authentication
      {:basic_auth, "~> 2.2"},

      # HTTP server
      {:cowboy, "~> 1.0"},
      {:plug_canonical_host, "~> 0.3"},

      # Errors
      {:sentry, "~> 5.0"},

      # Linting
      {:credo, "~> 0.8", only: [:dev, :test]},

      # Translation
      {:gettext, "~> 0.13"},

      # Time
      {:timex, "~> 3.1"}
    ]
  end

  defp aliases do
    [
      "ecto.setup": ["ecto.create", "ecto.migrate", "run priv/repo/seeds.exs"],
      "ecto.reset": ["ecto.drop", "ecto.setup"],
      test: ["ecto.create --quiet", "ecto.migrate", "test"]
    ]
  end
end
