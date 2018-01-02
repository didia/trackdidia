defmodule TrackdidiaWeb do
  @moduledoc """
  A module that keeps using definitions for controllers,
  views and so on.
  This can be used in your application as:
      use TrackdidiaWeb.Web, :controller
      use TrackdidiaWeb.Web, :view
  The definitions below will be executed for every view,
  controller, etc, so keep them short and clean, focused
  on imports, uses and aliases.
  Do NOT define functions inside the quoted expressions
  below.
  """

  def model do
    quote do
      use Ecto.Schema

      import Ecto
      import Ecto.Changeset
      import Ecto.Query, only: [from: 1, from: 2]
    end
  end

  def controller do
    quote do
      use Phoenix.Controller, namespace: TrackdidiaWeb

      alias TrackdidiaWeb.Repo
      import Ecto
      import Ecto.Query, only: [from: 1, from: 2]

      import TrackdidiaWeb.Router.Helpers
      import TrackdidiaWeb.Gettext
    end
  end

  def view do
    quote do
      # Import convenience functions from controllers
      import Phoenix.Controller, only: [get_csrf_token: 0, get_flash: 2, view_module: 1]

      # Use all HTML functionality (forms, tags, etc)
      use Phoenix.HTML

      import TrackdidiaWeb.Errors.Helpers
      import TrackdidiaWeb.Router.Helpers
      import TrackdidiaWeb.Gettext
    end
  end

  def router do
    quote do
      use Phoenix.Router
      use Plug.ErrorHandler
      use Sentry.Plug
    end
  end

  def channel do
    quote do
      use Phoenix.Channel

      alias TrackdidiaWeb.Repo
      import Ecto
      import Ecto.Query, only: [from: 1, from: 2]
      import TrackdidiaWeb.Gettext
    end
  end

  @doc """
  When used, dispatch to the appropriate controller/view/etc.
  """
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
