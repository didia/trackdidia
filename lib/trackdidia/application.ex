defmodule Trackdidia.Application do
  @moduledoc """
  Main entry point of the app
  """

  use Application
  alias Trackdidia.Repo
  alias TrackdidiaWeb.Endpoint

  def start(_type, _args) do
    import Supervisor.Spec

    children = [
      supervisor(Repo, []),
      supervisor(Endpoint, [])
    ]

    opts = [strategy: :one_for_one, name: Trackdidia.Supervisor]
    Supervisor.start_link(children, opts)
  end

  def config_change(changed, _new, removed) do
    Endpoint.config_change(changed, removed)
    :ok
  end
end
