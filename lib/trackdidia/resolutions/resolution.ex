defmodule Trackdidia.Resolutions.Resolution do
  use Ecto.Schema

  import Ecto.Changeset

  alias Trackdidia.Resolutions.Resolution

  schema "resolutions" do
    field(:description, :string)
    field(:title, :string)
    field(:days, {:array, :string})

    timestamps()
  end

  @doc false
  def changeset(%Resolution{} = resolution, attrs) do
    resolution
    |> cast(attrs, [:title, :description, :days])
    |> validate_subset(:days, ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])
    |> validate_required([:title, :description])
  end
end
