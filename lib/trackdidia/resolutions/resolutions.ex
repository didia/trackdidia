defmodule Trackdidia.Resolutions do
  @moduledoc """
  The Resolutions context.
  """

  import Ecto.Query, warn: false
  alias Trackdidia.Repo

  alias Trackdidia.Resolutions.Resolution

  @doc """
  Returns the list of resolutions.

  ## Examples

      iex> list_resolutions()
      [%Resolution{}, ...]

  """
  def list_resolutions do
    Repo.all(Resolution)
  end

  def list_resolutions(day) when day in 1..7 do
    Resolution
    |> where([res], ^day in res.days)
    |> Repo.all()
  end

  @doc """
  Gets a single templates.

  Raises `Ecto.NoResultsError` if the Resolution does not exist.

  ## Examples

      iex> get_resolution!(123)
      %Resolution{}

      iex> get_resolution!(456)
      ** (Ecto.NoResultsError)

  """
  def get_resolution!(id), do: Repo.get!(Resolution, id)

  @doc """
  Creates a templates.

  ## Examples

      iex> create_resolution(%{field: value})
      {:ok, %Resolution{}}

      iex> create_resolution(%{field: bad_value})
      {:error, %Ecto.Changeset{}}

  """
  def create_resolution(attrs \\ %{}) do
    %Resolution{}
    |> Resolution.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Updates a templates.

  ## Examples

      iex> update_resolution(templates, %{field: new_value})
      {:ok, %Resolution{}}

      iex> update_resolution(templates, %{field: bad_value})
      {:error, %Ecto.Changeset{}}

  """
  def update_resolution(%Resolution{} = resolution, attrs) do
    resolution
    |> Resolution.changeset(attrs)
    |> Repo.update()
  end

  @doc """
  Deletes a Resolution.

  ## Examples

      iex> delete_resolution(templates)
      {:ok, %Resolution{}}

      iex> delete_resolution(templates)
      {:error, %Ecto.Changeset{}}

  """
  def delete_resolution(%Resolution{} = resolution) do
    Repo.delete(resolution)
  end

  @doc """
  Returns an `%Ecto.Changeset{}` for tracking templates changes.

  ## Examples

      iex> change_resolution(templates)
      %Ecto.Changeset{source: %Resolution{}}

  """
  def change_resolution(%Resolution{} = resolution) do
    Resolution.changeset(resolution, %{})
  end
end
