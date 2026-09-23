package handlers
import (
 "context"
 "net/http/httptest"
 "testing"
 "github.com/gin-gonic/gin"
 coreexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)
func TestTokenFlowCredentialPin(t *testing.T) {
 c,_:=gin.CreateTestContext(httptest.NewRecorder())
 c.Request=httptest.NewRequest("POST","/v1/responses",nil)
 c.Request.Header.Set("X-Token-Flow-Auth","selected-credential")
 ctx:=context.WithValue(context.Background(),"gin",c)
 if got:=requestExecutionMetadata(ctx)[coreexecutor.PinnedAuthMetadataKey];got!="selected-credential" {t.Fatalf("credential pin missing: %v",got)}
 c.Request.Header.Del("X-Token-Flow-Auth")
 if _,ok:=requestExecutionMetadata(ctx)[coreexecutor.PinnedAuthMetadataKey];ok {t.Fatal("unexpected pin")}
}
