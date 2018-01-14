defmodule TrackdidiaWeb.Resolutions.Controller do
  use TrackdidiaWeb, :controller

  alias Trackdidia.Resolutions
  alias Trackdidia.Resolutions.Resolution

  plug(:put_layout, {TrackdidiaWeb.LayoutView, "layout.html"})

  def index(conn, _params) do
    resolutions = Resolutions.list_resolutions()
    render(conn, "index.html", resolutions: resolutions)
  end

  def new(conn, _params) do
    changeset = Resolutions.change_resolution(%Resolution{})
    render(conn, "new.html", changeset: changeset)
  end

  def create(conn, %{"resolution" => resolution_params}) do
    case Resolutions.create_resolution(resolution_params) do
      {:ok, resolution} ->
        conn
        |> put_flash(:info, "Resolution created successfully.")
        |> redirect(to: resolutions_path(conn, :show, resolution))

      {:error, %Ecto.Changeset{} = changeset} ->
        render(conn, "new.html", changeset: changeset)
    end
  end

  def show(conn, %{"id" => id}) do
    resolution = Resolutions.get_resolution!(id)
    render(conn, "show.html", resolution: resolution)
  end

  def edit(conn, %{"id" => id}) do
    resolution = Resolutions.get_resolution!(id)
    changeset = Resolutions.change_resolution(resolution)
    render(conn, "edit.html", resolution: resolution, changeset: changeset)
  end

  def update(conn, %{"id" => id, "resolution" => resolution_params}) do
    resolution = Resolutions.get_resolution!(id)

    case Resolutions.update_resolution(resolution, resolution_params) do
      {:ok, resolution} ->
        conn
        |> put_flash(:info, "Resolution updated successfully.")
        |> redirect(to: resolutions_path(conn, :show, resolution))

      {:error, %Ecto.Changeset{} = changeset} ->
        render(conn, "edit.html", resolution: resolution, changeset: changeset)
    end
  end

  def delete(conn, %{"id" => id}) do
    resolution = Resolutions.get_resolution!(id)
    {:ok, _resolution} = Resolutions.delete_resolution(resolution)

    conn
    |> put_flash(:info, "Resolution deleted successfully.")
    |> redirect(to: resolutions_path(conn, :index))
  end
end
