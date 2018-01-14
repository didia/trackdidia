defmodule Trackdidia.DummyDataSeeder do
  use Timex

  alias Trackdidia.Repo
  alias Trackdidia.Resolutions.Resolution

  @resolution_actions ["manger", "boire", "dormir", "me laver", "appeler Parousia", "regarder un film", "etudier", "coder"]

  def insert_resolution(resolution_suffix) do
    title = @resolution_actions
            |> Enum.random()
            |> (fn action -> "Je dois #{action} #{resolution_suffix}" end).()

    days = (1..7)
           |> Enum.random()
           |> (&Enum.take_random((1..7), &1)).()

    description = days
                  |> Enum.map(&Timex.day_name/1)
                  |> Enum.join(",")
                  |> (fn day_name_list -> "#{title} #{day_name_list}" end).()

    %Resolution{}
    |> Resolution.changeset(%{title: title, days: days, description: description })
    |> Repo.insert!
  end

  def clear_all_resolutions do
    Repo.delete_all Resolution
  end
end

alias Trackdidia.DummyDataSeeder

DummyDataSeeder.clear_all_resolutions

(1..20) |> Enum.each( fn order -> DummyDataSeeder.insert_resolution(order) end)

