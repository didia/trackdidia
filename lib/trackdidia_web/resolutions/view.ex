defmodule TrackdidiaWeb.Resolutions.View do
  use TrackdidiaWeb, :view
  use Phoenix.View, root: "lib/trackdidia_web", path: "resolutions/templates", namespace: TrackdidiaWeb
  use Timex

  def days_options do
    1..7 |> Enum.map(&day_option/1)
  end

  defp day_option(day_number) do
    day_number
    |> Timex.day_name()
    |> (fn (day_name) -> {day_name, day_number} end).()
  end

  def day_name(day_number) do
    day_number |> Timex.day_name()
  end
end
