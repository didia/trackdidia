defmodule TrackdidiaWeb.Resolutions.ControllerTest do
  use TrackdidiaWeb.ConnCase

  alias Trackdidia.Resolutions

  @create_attrs %{description: "some description", title: "some title", days: ["monday", "tuesday"]}
  @update_attrs %{description: "some updated description", title: "some updated title", days: ["sunday"]}
  @invalid_attrs %{description: nil, title: nil}

  def fixture(:resolution) do
    {:ok, resolution} = Resolutions.create_resolution(@create_attrs)
    resolution
  end

  describe "index" do
    test "lists all resolutions", %{conn: conn} do
      conn = get(conn, resolutions_path(conn, :index))
      assert html_response(conn, 200) =~ "Listing Resolutions"
    end
  end

  describe "new templates" do
    test "renders form", %{conn: conn} do
      conn = get(conn, resolutions_path(conn, :new))
      assert html_response(conn, 200) =~ "New Resolution"
    end
  end

  describe "create templates" do
    test "redirects to show when data is valid", %{conn: conn} do
      conn = post(conn, resolutions_path(conn, :create), resolution: @create_attrs)

      assert %{id: id} = redirected_params(conn)
      assert redirected_to(conn) == resolutions_path(conn, :show, id)

      conn = get(conn, resolutions_path(conn, :show, id))
      assert html_response(conn, 200) =~ "Show Resolution"
    end

    test "renders errors when data is invalid", %{conn: conn} do
      conn = post(conn, resolutions_path(conn, :create), resolution: @invalid_attrs)
      assert html_response(conn, 200) =~ "New Resolution"
    end
  end

  describe "edit templates" do
    setup [:create_resolution]

    test "renders form for editing chosen templates", %{conn: conn, resolution: resolution} do
      conn = get(conn, resolutions_path(conn, :edit, resolution))
      assert html_response(conn, 200) =~ "Edit Resolution"
    end
  end

  describe "update templates" do
    setup [:create_resolution]

    test "redirects when data is valid", %{conn: conn, resolution: resolution} do
      conn = put(conn, resolutions_path(conn, :update, resolution), resolution: @update_attrs)
      assert redirected_to(conn) == resolutions_path(conn, :show, resolution)

      conn = get(conn, resolutions_path(conn, :show, resolution))
      assert html_response(conn, 200) =~ "some updated description"
    end

    test "renders errors when data is invalid", %{conn: conn, resolution: resolution} do
      conn = put(conn, resolutions_path(conn, :update, resolution), resolution: @invalid_attrs)
      assert html_response(conn, 200) =~ "Edit Resolution"
    end
  end

  describe "delete templates" do
    setup %{conn: conn} do
      resolution = fixture(:resolution)

      conn =
        conn
        |> bypass_through(TrackdidiaWeb.Router)
        |> delete(resolutions_path(conn, :delete, resolution))

      {:ok, %{conn: conn, resolution: resolution}}
    end

    #    setup [:create_resolution]

    test "deletes chosen templates", %{conn: conn, resolution: resolution} do
      conn = delete(conn, resolutions_path(conn, :delete, resolution))
      assert redirected_to(conn) == resolutions_path(conn, :index)

      assert_error_sent(404, fn ->
        get(conn, resolutions_path(conn, :show, resolution))
      end)
    end
  end

  defp create_resolution(_) do
    resolution = fixture(:resolution)
    {:ok, resolution: resolution}
  end
end
