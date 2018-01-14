defmodule TrackdidiaWeb.Home.View do
  use TrackdidiaWeb, :view
  use Phoenix.View, root: "lib/trackdidia_web", path: "home/templates", namespace: TrackdidiaWeb
  use Timex

  def current_day do
    Timex.now() |> Timex.day()
  end

  def current_day_name do
    Timex.now() |> Timex.weekday() |> Timex.day_shortname()
  end
end
