defmodule TrackdidiaWeb.Home.Controller do
  use TrackdidiaWeb, :controller

  alias Trackdidia.Resolutions

  plug(:put_layout, {TrackdidiaWeb.LayoutView, "layout.html"})

  def index(conn, _) do
    today = Timex.now() |> Timex.weekday()
    resolutions = Resolutions.list_resolutions(today)
    render(conn, "home.html", resolutions: resolutions)
  end
end
