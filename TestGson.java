import com.google.gson.Gson;
public class TestGson {
    public static class ScoutingEvent {
        private boolean isHost = true;
        public boolean isHost() { return isHost; }
        public void setHost(boolean host) { isHost = host; }
    }
    public static void main(String[] args) {
        System.out.println(new Gson().toJson(new ScoutingEvent()));
    }
}
