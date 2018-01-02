defmodule TrackdidiaWeb.Home.Controller do
  use TrackdidiaWeb, :controller

  plug(:put_layout, {TrackdidiaWeb.LayoutView, "layout.html"})

  def index(conn, _), do: render(conn, "home.html")
end
