defmodule Trackdidia.Resolutions.Resolution do
  use TrackdidiaWeb, :model
  use Timex

  import Ecto.Changeset

  alias Trackdidia.Resolutions.Resolution

  schema "resolutions" do
    field(:description, :string)
    field(:title, :string)
    field(:days, {:array, :integer})

    timestamps()
  end

  @doc false
  def changeset(%Resolution{} = resolution, attrs) do
    resolution
    |> cast(attrs, [:title, :description, :days])
    |> validate_subset(:days, 1..7)
    |> validate_required([:title, :description, :days])
  end
end
